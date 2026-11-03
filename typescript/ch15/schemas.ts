// Chapter 15: what the “Comptoir for Awa” server announces of its tools, its resources and its prompts.
// These are the texts and the schemas the Python version publishes (python/ch15/comptoir_for_awa.py), as
// pydantic writes them from its models and its docstrings, read by an MCP client from the English Python
// server (the French edition read them on October 23, 2026): Claude reads the same thing in both versions.
// A test compares them with the Python server.

export const INSTRUCTIONS = "Comptoir for Awa gives access to the sales and the stock of Délices d'Awa, Awa's juice business in Cotonou. Rules:\n1. The figures (bottles, amounts, differences) come from the tools: do not recalculate them and do not round them.\n2. To correct the stock: call prepare_correction, show Awa the difference as the tool gives it, and wait for her explicit consent before apply_correction. One correction per product, never several in a row without consent for each.\n3. Never offer to change anything other than the stock: orders and customers are not changed here.\n4. Answer Awa in English, politely, simply: she is not a computer specialist.";

export const TOOLS = {
  "orders_of_the_day": {
    "title": "Orders of a day",
    "description": "The confirmed orders of a day: time, customer, neighborhood, products, total. For “my orders\ntoday”, “what did I deliver on Saturday”. Changes nothing.",
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "input": {
      "type": "object",
      "properties": {
        "day": {
          "anyOf": [
            {
              "format": "date",
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "YYYY-MM-DD. Without a date: today.",
          "title": "Day"
        }
      },
      "title": "orders_of_the_dayArguments"
    },
    "output": {
      "$defs": {
        "OrderOfTheDay": {
          "properties": {
            "number": {
              "title": "Number",
              "type": "string"
            },
            "time": {
              "title": "Time",
              "type": "string"
            },
            "customer": {
              "description": "First name and initial of the surname.",
              "title": "Customer",
              "type": "string"
            },
            "neighborhood": {
              "title": "Neighborhood",
              "type": "string"
            },
            "products": {
              "title": "Products",
              "type": "string"
            },
            "total_fcfa": {
              "title": "Total Fcfa",
              "type": "integer"
            }
          },
          "required": [
            "number",
            "time",
            "customer",
            "neighborhood",
            "products",
            "total_fcfa"
          ],
          "title": "OrderOfTheDay",
          "type": "object"
        }
      },
      "properties": {
        "day": {
          "title": "Day",
          "type": "string"
        },
        "count": {
          "title": "Count",
          "type": "integer"
        },
        "total_fcfa": {
          "title": "Total Fcfa",
          "type": "integer"
        },
        "orders": {
          "items": {
            "$ref": "#/$defs/OrderOfTheDay"
          },
          "title": "Orders",
          "type": "array"
        },
        "summary": {
          "description": "A sentence to say to Awa, with the exact figures.",
          "title": "Summary",
          "type": "string"
        }
      },
      "required": [
        "day",
        "count",
        "total_fcfa",
        "orders",
        "summary"
      ],
      "title": "OrdersOfTheDay",
      "type": "object"
    }
  },
  "stock": {
    "title": "Stock",
    "description": "The stock of each product, with the shortages and the low stocks. Changes nothing.",
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "input": {
      "type": "object",
      "properties": {},
      "title": "stockArguments"
    },
    "output": {
      "$defs": {
        "StockLine": {
          "properties": {
            "product": {
              "title": "Product",
              "type": "string"
            },
            "format": {
              "title": "Format",
              "type": "string"
            },
            "quantity": {
              "title": "Quantity",
              "type": "integer"
            },
            "state": {
              "enum": [
                "out_of_stock",
                "low",
                "sufficient"
              ],
              "title": "State",
              "type": "string"
            }
          },
          "required": [
            "product",
            "format",
            "quantity",
            "state"
          ],
          "title": "StockLine",
          "type": "object"
        }
      },
      "properties": {
        "products": {
          "items": {
            "$ref": "#/$defs/StockLine"
          },
          "title": "Products",
          "type": "array"
        },
        "summary": {
          "title": "Summary",
          "type": "string"
        }
      },
      "required": [
        "products",
        "summary"
      ],
      "title": "Stock",
      "type": "object"
    }
  },
  "sales_of_the_week": {
    "title": "Sales of a week",
    "description": "The sales of a week, Monday to Sunday: orders, total, bottles per product, and\ncomparison with the previous week. Changes nothing.",
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "input": {
      "type": "object",
      "properties": {
        "a_day_of_the_week": {
          "anyOf": [
            {
              "format": "date",
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "YYYY-MM-DD, any day of the week wanted (Monday to Sunday). Without a date: the current week.",
          "title": "A Day Of The Week"
        }
      },
      "title": "sales_of_the_weekArguments"
    },
    "output": {
      "$defs": {
        "ProductSales": {
          "properties": {
            "product": {
              "title": "Product",
              "type": "string"
            },
            "quantity": {
              "title": "Quantity",
              "type": "integer"
            },
            "amount_fcfa": {
              "title": "Amount Fcfa",
              "type": "integer"
            }
          },
          "required": [
            "product",
            "quantity",
            "amount_fcfa"
          ],
          "title": "ProductSales",
          "type": "object"
        }
      },
      "properties": {
        "start": {
          "title": "Start",
          "type": "string"
        },
        "end": {
          "title": "End",
          "type": "string"
        },
        "orders": {
          "title": "Orders",
          "type": "integer"
        },
        "total_fcfa": {
          "title": "Total Fcfa",
          "type": "integer"
        },
        "by_product": {
          "items": {
            "$ref": "#/$defs/ProductSales"
          },
          "title": "By Product",
          "type": "array"
        },
        "previous_week_fcfa": {
          "title": "Previous Week Fcfa",
          "type": "integer"
        },
        "summary": {
          "title": "Summary",
          "type": "string"
        }
      },
      "required": [
        "start",
        "end",
        "orders",
        "total_fcfa",
        "by_product",
        "previous_week_fcfa",
        "summary"
      ],
      "title": "WeekSales",
      "type": "object"
    }
  },
  "prepare_correction": {
    "title": "Prepare a stock correction",
    "description": "First step of a stock correction after an inventory: compares what Awa counted with the Comptoir's\nstock and returns the difference with a token valid for 10 minutes. Does not change the stock. Show\nthe difference to Awa (to_tell_awa) and wait for her consent before apply_correction.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "input": {
      "type": "object",
      "properties": {
        "product": {
          "enum": [
            "Bissap juice",
            "Ginger juice",
            "Pineapple juice",
            "Soursop juice",
            "Bissap syrup",
            "Ginger syrup"
          ],
          "title": "Product",
          "type": "string"
        },
        "counted_quantity": {
          "description": "What Awa counted on the shelf.",
          "maximum": 1000,
          "minimum": 0,
          "title": "Counted Quantity",
          "type": "integer"
        }
      },
      "required": [
        "product",
        "counted_quantity"
      ],
      "title": "prepare_correctionArguments"
    },
    "output": {
      "properties": {
        "product": {
          "title": "Product",
          "type": "string"
        },
        "current_stock": {
          "title": "Current Stock",
          "type": "integer"
        },
        "counted_quantity": {
          "title": "Counted Quantity",
          "type": "integer"
        },
        "difference": {
          "title": "Difference",
          "type": "integer"
        },
        "token": {
          "title": "Token",
          "type": "string"
        },
        "valid_until": {
          "title": "Valid Until",
          "type": "string"
        },
        "to_tell_awa": {
          "title": "To Tell Awa",
          "type": "string"
        }
      },
      "required": [
        "product",
        "current_stock",
        "counted_quantity",
        "difference",
        "token",
        "valid_until",
        "to_tell_awa"
      ],
      "title": "Correction",
      "type": "object"
    }
  },
  "apply_correction": {
    "title": "Apply a stock correction",
    "description": "Second step: replaces the product's stock with the counted quantity. Only with a token from\nprepare_correction, and only after Awa's explicit consent to the difference announced. A token\ncan be used only once.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "_meta": {
      "anthropic/requiresUserInteraction": true
    },
    "input": {
      "type": "object",
      "properties": {
        "token": {
          "description": "The token returned by prepare_correction.",
          "title": "Token",
          "type": "string"
        }
      },
      "required": [
        "token"
      ],
      "title": "apply_correctionArguments"
    },
    "output": {
      "properties": {
        "product": {
          "title": "Product",
          "type": "string"
        },
        "before": {
          "title": "Before",
          "type": "integer"
        },
        "after": {
          "title": "After",
          "type": "integer"
        },
        "summary": {
          "title": "Summary",
          "type": "string"
        }
      },
      "required": [
        "product",
        "before",
        "after",
        "summary"
      ],
      "title": "AppliedCorrection",
      "type": "object"
    }
  }
} as const;

export const RESOURCES = [
  {
    "name": "catalog",
    "title": "Catalog and terms",
    "uri": "comptoir://catalog",
    "description": "The products of Délices d'Awa, their prices and the ordering and delivery terms.",
    "mimeType": "text/markdown"
  }
] as const;

export const RESOURCE_TEMPLATES = [
  {
    "name": "one_order",
    "title": "One order",
    "uriTemplate": "comptoir://order/{number}",
    "description": "The details of an order, by its number (for example C-0042).",
    "mimeType": "text/markdown"
  }
] as const;

export const PROMPTS = [
  {
    "name": "evening_review",
    "title": "Evening review",
    "description": "The end-of-day review: orders, stock to watch, what to prepare for tomorrow.",
    "arguments": [
      {
        "name": "day",
        "required": false
      }
    ]
  },
  {
    "name": "inventory",
    "title": "Inventory",
    "description": "Guides the inventory product by product, with a stock correction only after consent.",
    "arguments": []
  }
] as const;
