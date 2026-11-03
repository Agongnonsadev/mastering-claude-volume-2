// Chapter 16: what the online Comptoir announces in addition to the chapter 15 server: the weekly_report
// tool and the confirmation form of apply_correction. These are the texts and the schemas the Python
// version publishes (python/ch16/online_server.py), as pydantic writes them, read by an MCP client from the
// English Python server (the French edition read them on October 23, 2026). A test compares them with the
// Python server.

export const REPORT = {
  "title": "Weekly report",
  "description": "The complete report of a week: sales, day by day, by neighborhood, and comparison with the\nprevious week. Reports its progress during the calculation. Changes nothing.",
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
        "description": "YYYY-MM-DD, any day of the week wanted. Without a date: the current week.",
        "title": "A Day Of The Week"
      }
    },
    "title": "weekly_reportArguments"
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
      },
      "ReportDay": {
        "properties": {
          "day": {
            "title": "Day",
            "type": "string"
          },
          "orders": {
            "title": "Orders",
            "type": "integer"
          },
          "total_fcfa": {
            "title": "Total Fcfa",
            "type": "integer"
          }
        },
        "required": [
          "day",
          "orders",
          "total_fcfa"
        ],
        "title": "ReportDay",
        "type": "object"
      },
      "WeekSales": {
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
    "properties": {
      "sales": {
        "$ref": "#/$defs/WeekSales"
      },
      "by_day": {
        "items": {
          "$ref": "#/$defs/ReportDay"
        },
        "title": "By Day",
        "type": "array"
      },
      "by_neighborhood": {
        "additionalProperties": {
          "type": "integer"
        },
        "description": "Total in FCFA per neighborhood, from the highest to the lowest.",
        "title": "By Neighborhood",
        "type": "object"
      },
      "summary": {
        "title": "Summary",
        "type": "string"
      }
    },
    "required": [
      "sales",
      "by_day",
      "by_neighborhood",
      "summary"
    ],
    "title": "WeekReport",
    "type": "object"
  }
} as const;

/** The confirmation form (the Python version's Confirmation model). */
export const CONFIRMATION = {
  "properties": {
    "confirmed": {
      "description": "Tick to apply the correction.",
      "title": "Confirmed",
      "type": "boolean"
    }
  },
  "required": [
    "confirmed"
  ],
  "type": "object"
} as const;
