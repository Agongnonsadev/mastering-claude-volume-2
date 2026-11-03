"""Chapter 3: list the models available to your key, with their limits and their retirement date.

The Models API generates no text: it consumes no tokens.
Run, from the python/ folder:  python -m ch03.list_models
"""

import anthropic

client = anthropic.Anthropic()

for model in client.models.list():
    retirement = model.retires_at.date().isoformat() if model.retires_at else "not announced"
    context = f"{model.max_input_tokens:,}" if model.max_input_tokens else "?"
    output = f"{model.max_tokens:,}" if model.max_tokens else "?"
    print(
        f"{model.id:<28} {model.lifecycle:<11} context {context:>9} · "
        f"output {output:>7} · retirement: {retirement}"
    )
