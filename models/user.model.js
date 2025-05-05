const { hash } = require("bcryptjs");
const { Schema, model } = require("mongoose");
const { logger } = require('../helpers');


const userSchema = new Schema(
    {
        email: String,
        name: String,
        password: String,
        roleId: {
            type: Schema.Types.ObjectId,
            ref: "Role",
            required: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true, versionKey: false, }
);

userSchema.pre('save', async function (next) {
    try {
        if (this.isModified('password') || this.isNew)
            this.password = await hash(this.password, 10);

        next();
    } catch (error) {
        logger.error(`PRE SAVE ERROR: ${error}`);
        next(error);
    }
});

userSchema.set("toJSON", {
    transform: function (doc, ret, opt) {
        delete ret["password"];
        return ret;
    },
});

let userModel = model("User", userSchema, "User");
module.exports = userModel;
