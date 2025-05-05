const { response, logger } = require('../helpers');

module.exports = (schema) => async (req, res, next) => {

    const paths = Object.keys(schema);
    if (!paths.length) return next();
    if (!paths.includes("body") && !paths.includes("query") && !paths.includes("params")) return next();


    for (let path of paths) {

        const dataForValidation = req[path];
        const { value, error } = schema[path].validate(dataForValidation, {
            allowUnknown: false,
            stripUnknown: true,
        });


        if (error) {

            logger.error(`✘ VALIDATION ERROR: ${error}`);
            const context = error?.details;

            return response.BAD_REQUEST({
                res,
                message: `Validation failed for ${path}.`,
                data: { context, fieldsAccepted: Object.keys(schema[path].describe().keys) }
            });

        }

        req[path] = value;
    }

    next();
};
