const { Schema, model } = require("mongoose");

let roleSchema = new Schema(
    {
        name: String,
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true, versionKey: false, }
);

let roleModel = model("Role", roleSchema, "Role");

module.exports = roleModel;
