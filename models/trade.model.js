const { Schema, model } = require("mongoose");

let tradeSchema = new Schema(
    {
        symbol: String,
        gap: Number,
        eclipseBuffer: Number,
        volume: Number,
        strategy: String,
        direction: String,
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true, versionKey: false, }
);

let tradeModel = model("Trade", tradeSchema, "Trade");

module.exports = tradeModel;
