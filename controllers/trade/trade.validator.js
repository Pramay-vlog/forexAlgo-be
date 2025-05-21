const Joi = require("joi");
const { constants: { ENUM: { STRATEGY } } } = require("../../helpers");
const validator = require("../../middleware/validator");


module.exports = {

    Trade: validator({
        body: Joi.object({
            symbol: Joi.string().required(),
            GAP: Joi.number().required(),
            ECLIPSE_BUFFER: Joi.number().required(),
            volume: Joi.number().required(),
            strategy: Joi.string().valid(...Object.values(STRATEGY)).required(),
        }),
    }),

    TradeHistory: validator({
        params: Joi.object({
            tradeId: Joi.string()
                .pattern(/^[0-9a-fA-F]{24}$/)
                .required(),
        }),
    })

};
