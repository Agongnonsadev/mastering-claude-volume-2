"""Chapter 16: the Comptoir's OAuth authorization server, for a single person, Awa.

The online MCP server opens its tools only with an access token. This module issues those tokens:
it implements the “provider” that the MCP SDK expects (OAuthAuthorizationServerProvider); the
SDK serves the addresses of the OAuth protocol (metadata, /authorize, /token, /register,
/revoke) and checks PKCE. What this module adds:
- a login page, in English, where Awa types her password and sees who is asking for access;
- an allowlist of callback addresses: the Claude app, and Claude Code on this computer;
- opaque tokens, of which only the hash is kept, in a SQLite database (nothing in memory:
  several processes can serve the same tokens);
- the rotation of refresh tokens, and the revocation of everything if a used one comes back;
- a block after five wrong passwords in fifteen minutes.

For several people or a company, prefer an identity provider (Keycloak, Auth0,
Entra…): the SDK then checks its tokens, and this module is no longer needed.

Hash Awa's password, to put in COMPTOIR_PASSWORD_HASH; revoke everything:
    python -m ch16.authorization hash
    python -m ch16.authorization disconnect-all customer_data/authorization.sqlite3
"""

import base64
import getpass
import hashlib
import hmac
import html
import secrets
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import AnyUrl
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import InvalidRedirectUriError, OAuthClientInformationFull, OAuthToken

SCOPE = "comptoir"
CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback"  # claude.ai, desktop and mobile apps
REQUEST_DURATION = 10 * 60
CODE_DURATION = 5 * 60
ACCESS_DURATION = 60 * 60
REFRESH_DURATION = 30 * 24 * 60 * 60
MAX_ATTEMPTS, ATTEMPT_WINDOW = 5, 15 * 60


# ---------- Password -----------------------------------------------------------------------


def hash_password(password: str, salt: bytes | None = None) -> str:
    """scrypt, with a random salt: “scrypt:16384:8:1:salt:hash”.

    Colons and not “$”: Docker Compose would read “$…” as a variable in a .env file."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
    return f"scrypt:16384:8:1:{b64(salt)}:{b64(digest)}"


def check_password(password: str, expected: str) -> bool:
    try:
        _, n, r, p, salt, digest = expected.split(":")
        decode = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        computed = hashlib.scrypt(password.encode(), salt=decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(computed, decode(digest))


def _fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- Callback addresses -------------------------------------------------------------------


def _local(uri: str) -> bool:
    parts = urlsplit(uri)
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")


def callback_allowed(uri: str) -> bool:
    """The Claude app, or a client on this computer (Claude Code, our scripts), any port."""
    return uri == CLAUDE_CALLBACK or (_local(uri) and urlsplit(uri).path == "/callback")


def _without_port(uri: str) -> str:
    p = urlsplit(uri)
    return f"{p.scheme}://{p.hostname}{p.path}"


class AwaClient(OAuthClientInformationFull):
    """A registered client, for which a local callback address is valid for every port.

    Claude Code changes port at each session: RFC 8252 (§ 7.3) and Anthropic's documentation
    ask to compare a loopback address without its port.
    """

    def validate_redirect_uri(self, redirect_uri: AnyUrl | None) -> AnyUrl:
        if redirect_uri is not None and self.redirect_uris:
            requested = str(redirect_uri)
            for registered in map(str, self.redirect_uris):
                if requested == registered or (_local(requested) and _local(registered)
                                               and _without_port(requested) == _without_port(registered)):
                    return redirect_uri
            raise InvalidRedirectUriError(f"Callback address not registered for this client: {requested}")
        return super().validate_redirect_uri(redirect_uri)


# ---------- The provider ---------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes (fingerprint TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (fingerprint TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
    scopes TEXT NOT NULL, resource TEXT, expires REAL NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS consents (request TEXT PRIMARY KEY, callback TEXT NOT NULL, expires REAL NOT NULL);
"""


class AwaProvider:
    """Awa's authorization server, plugged into the MCP SDK (auth_server_provider)."""

    def __init__(self, database: str | Path, public_url: str, resource: str, password_hash: str,
                 clock=time.time):
        self.path = str(database)
        self.url = public_url.rstrip("/")
        self.resource = resource
        self.password_hash = password_hash
        self.clock = clock
        with self._db() as db:
            db.executescript(_SCHEMA)

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    # --- Clients (dynamic registration, RFC 7591) ---

    async def get_client(self, client_id: str) -> AwaClient | None:
        with self._db() as db:
            row = db.execute("SELECT info FROM clients WHERE client_id = ?", (client_id,)).fetchone()
        return AwaClient.model_validate_json(row["info"]) if row else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        refused = [str(u) for u in client_info.redirect_uris or [] if not callback_allowed(str(u))]
        if refused:
            raise RegistrationError("invalid_redirect_uri",
                                    f"Callback address refused by this server: {', '.join(refused)}")
        with self._db() as db:
            db.execute("INSERT INTO clients VALUES (?, ?, ?)",
                       (client_info.client_id, client_info.model_dump_json(), self.clock()))

    # --- Authorization: the login page ---

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource and params.resource.rstrip("/") != self.resource.rstrip("/"):
            raise AuthorizeError("invalid_target", "This server issues tokens only for the Comptoir.")
        identifier = secrets.token_urlsafe(24)
        with self._db() as db:
            db.execute("DELETE FROM requests WHERE expires < ?", (self.clock(),))
            db.execute("INSERT INTO requests VALUES (?, ?, ?, ?)",
                       (identifier, client.client_id, params.model_dump_json(), self.clock() + REQUEST_DURATION))
        return f"{self.url}/login?request={identifier}"

    def _blocked(self, db: sqlite3.Connection) -> bool:
        (failures,) = db.execute("SELECT COUNT(*) FROM failures WHERE at > ?",
                                 (self.clock() - ATTEMPT_WINDOW,)).fetchone()
        return failures >= MAX_ATTEMPTS

    async def login_page(self, request: Request) -> Response:
        identifier = request.query_params.get("request", "")
        with self._db() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ? AND expires > ?",
                             (identifier, self.clock())).fetchone()
            if row is None:
                # On a connection that drops, the response to the first submission can be lost and the browser
                # submits the form again: the same redirection is returned, without a new code. Harmless: the
                # code works only once, and only for the client that holds the PKCE verifier.
                consent = db.execute("SELECT callback FROM consents WHERE request = ? AND expires > ?",
                                     (identifier, self.clock())).fetchone()
                if consent:
                    return RedirectResponse(consent["callback"], 302)
                return _page("This request has expired", "<p>Go back to Claude and start the connection again.</p>",
                             400)
            params = AuthorizationParams.model_validate_json(row["params"])
            client = await self.get_client(row["client_id"])
            if request.method == "GET":
                return _consent_page(identifier, client, params)
            form = await request.form()
            if form.get("decision") == "deny":
                db.execute("DELETE FROM requests WHERE id = ?", (identifier,))
                return RedirectResponse(construct_redirect_uri(str(params.redirect_uri), error="access_denied",
                                                               state=params.state, iss=self.url), 302)
            if self._blocked(db):
                return _consent_page(identifier, client, params, "Too many attempts: wait fifteen minutes.", 429)
            if not check_password(str(form.get("password", "")), self.password_hash):
                db.execute("INSERT INTO failures VALUES (?)", (self.clock(),))
                return _consent_page(identifier, client, params, "Wrong password.", 401)
            code = secrets.token_urlsafe(32)
            data = AuthorizationCode(
                code=code, scopes=params.scopes or [SCOPE], expires_at=self.clock() + CODE_DURATION,
                client_id=client.client_id, code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
                redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                resource=params.resource or self.resource, subject="awa")
            # RFC 9207: the issuer comes with the code, and the client checks it.
            callback = construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state, iss=self.url)
            db.execute("DELETE FROM requests WHERE id = ?", (identifier,))
            db.execute("INSERT INTO codes VALUES (?, ?, ?)", (_fingerprint(code), data.model_dump_json(),
                                                              data.expires_at))
            db.execute("INSERT INTO consents VALUES (?, ?, ?)", (identifier, callback, data.expires_at))
        return RedirectResponse(callback, 302)

    # --- Codes and tokens ---

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str
                                      ) -> AuthorizationCode | None:
        with self._db() as db:
            row = db.execute("SELECT data FROM codes WHERE fingerprint = ?", (_fingerprint(authorization_code),)
                             ).fetchone()
        if row is None:
            return None
        code = AuthorizationCode.model_validate_json(row["data"])
        return code if code.client_id == client.client_id else None

    def _issue(self, db: sqlite3.Connection, client_id: str, scopes: list[str], resource: str | None) -> OAuthToken:
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = self.clock()
        for token, kind, duration in ((access, "access", ACCESS_DURATION), (refresh, "refresh", REFRESH_DURATION)):
            db.execute("INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?, 'valid')",
                       (_fingerprint(token), kind, client_id, " ".join(scopes), resource, now + duration))
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=ACCESS_DURATION,
                          refresh_token=refresh, scope=" ".join(scopes))

    async def exchange_authorization_code(self, client: OAuthClientInformationFull,
                                          authorization_code: AuthorizationCode) -> OAuthToken:
        with self._db() as db:
            deleted = db.execute("DELETE FROM codes WHERE fingerprint = ?", (_fingerprint(authorization_code.code),))
            if deleted.rowcount != 1:  # a code works only once
                raise TokenError("invalid_grant", "This code has already been used.")
            return self._issue(db, client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM tokens WHERE fingerprint = ? AND kind = 'refresh'",
                             (_fingerprint(refresh_token),)).fetchone()
            if row is None or row["client_id"] != client.client_id:
                return None
            if row["state"] == "used":
                # A refresh token already exchanged that comes back: it was stolen, or copied.
                # Everything this client holds is revoked (OAuth 2.1, token rotation).
                db.execute("UPDATE tokens SET state = 'revoked' WHERE client_id = ?", (client.client_id,))
                return None
            if row["state"] != "valid" or row["expires"] < self.clock():
                return None
        return RefreshToken(token=refresh_token, client_id=row["client_id"], scopes=row["scopes"].split(),
                            expires_at=int(row["expires"]), resource=row["resource"], subject="awa")

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken,
                                     scopes: list[str]) -> OAuthToken:
        with self._db() as db:
            db.execute("UPDATE tokens SET state = 'used' WHERE fingerprint = ?", (_fingerprint(refresh_token.token),))
            return self._issue(db, client.client_id, scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token: str) -> AccessToken | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM tokens WHERE fingerprint = ? AND kind = 'access'",
                             (_fingerprint(token),)).fetchone()
        if row is None or row["state"] != "valid" or row["expires"] < self.clock():
            return None
        return AccessToken(token=token, client_id=row["client_id"], scopes=row["scopes"].split(),
                           expires_at=int(row["expires"]), resource=row["resource"], subject="awa",
                           claims={"iss": self.url})

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        with self._db() as db:
            db.execute("UPDATE tokens SET state = 'revoked' WHERE fingerprint = ?", (_fingerprint(token.token),))

    def disconnect_all(self) -> int:
        """Revokes all the tokens: to do if Awa's phone is lost. Returns the number revoked."""
        with self._db() as db:
            return db.execute("UPDATE tokens SET state = 'revoked' WHERE state = 'valid'").rowcount


# ---------- The pages ----------------------------------------------------------------------------

_STYLE = ("body{font-family:system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.5}"
          "button{font-size:1rem;padding:.6rem 1rem;margin:.3rem .3rem 0 0}input{font-size:1rem;padding:.5rem;width:100%}"
          ".alert{background:#fde8e8;padding:.6rem;border-radius:.4rem}.note{background:#fff6dd;padding:.6rem;border-radius:.4rem}")


def _origin(uri: str) -> str:
    p = urlsplit(uri)
    return f"{p.scheme}://{p.netloc}"


def _page(title: str, body: str, status: int = 200, callback: str | None = None) -> HTMLResponse:
    # form-action also applies to the redirection that follows the form submission: without the origin of
    # the callback address, the browser would block the way back to Claude (observed during the trial).
    action = "'self'" + (f" {_origin(callback)}" if callback else "")
    page = (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
            f"content=\"width=device-width,initial-scale=1\"><title>{html.escape(title)}</title><style>{_STYLE}</style>"
            f"</head><body><h1>{html.escape(title)}</h1>{body}</body></html>")
    return HTMLResponse(page, status, headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY",
                                               "Content-Security-Policy": f"default-src 'none'; style-src 'unsafe-inline'; form-action {action}"})


def _consent_page(identifier: str, client: OAuthClientInformationFull | None, params: AuthorizationParams,
                  error: str = "", status: int = 200) -> HTMLResponse:
    callback = urlsplit(str(params.redirect_uri))
    text = lambda s: html.escape(s, quote=False)  # a text between two tags: < > & are enough
    name = text((client.client_name if client else None) or "An application")
    body = (f"<p><strong>{name}</strong> is asking for access to your Comptoir: read your orders, your stock and "
            f"your sales, and correct the stock with your consent.</p><p>After your answer, you will come back to "
            f"<strong>{text(callback.hostname or '')}</strong>.</p>")
    if _local(str(params.redirect_uri)):
        body += ("<p class=\"note\">The return happens on this computer. Accept only if you have just started the "
                 "connection yourself, for example from Claude Code.</p>")
    if error:
        body += f"<p class=\"alert\">{text(error)}</p>"
    body += (f"<form method=\"post\"><input type=\"hidden\" name=\"request\" value=\"{html.escape(identifier)}\">"
             "<label>Your Comptoir password<input type=\"password\" name=\"password\" "
             "autocomplete=\"current-password\" autofocus></label>"
             "<button name=\"decision\" value=\"allow\">Allow</button>"
             "<button name=\"decision\" value=\"deny\">Deny</button></form>")
    return _page("Comptoir for Awa", body, status, callback=str(params.redirect_uri))


def main() -> None:
    if sys.argv[1:] == ["hash"]:
        password = getpass.getpass("Awa's password (it is not displayed): ")
        if len(password) < 12:
            raise SystemExit("At least 12 characters.")
        print(hash_password(password))
    elif sys.argv[1:2] == ["disconnect-all"] and len(sys.argv) == 3:
        # Phone lost, password changed: every application will have to log in again.
        database = Path(sys.argv[2])
        if not database.is_file():
            raise SystemExit(f"Database not found: {database}")
        with sqlite3.connect(database) as db:
            n = db.execute("UPDATE tokens SET state = 'revoked' WHERE state = 'valid'").rowcount
        print(f"{n} token(s) revoked.")
    else:
        raise SystemExit("Usage: python -m ch16.authorization hash\n"
                         "       python -m ch16.authorization disconnect-all <token database>")


if __name__ == "__main__":
    main()
