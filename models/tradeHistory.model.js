const { Schema, model } = require("mongoose");

let tradeHistorySchema = new Schema(
    {
        tradeId: {
            type: Schema.Types.ObjectId,
            ref: "Trade",
        },
        price: Number,
        action: String,
        direction: String,
        checkpoint: Number,
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true, versionKey: false, }
);

let tradeHistoryModel = model("TradeHistory", tradeHistorySchema, "TradeHistory");

module.exports = tradeHistoryModel;
