const Joi = require("joi");
const { constants: { ENUM: { ROLE } } } = require("../../helpers");
const validator = require("../../middleware/validator");


module.exports = {

    createRole: validator({
        body: Joi.object({
            name: Joi.string().valid(...Object.values(ROLE)).required(),
        }),
    }),

};
