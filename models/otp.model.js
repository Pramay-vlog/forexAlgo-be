const { Schema, model } = require("mongoose");

let otpSchema = new Schema(
    {
        email: String,
        otp: String,
        expireAt: Date,
    },
    { timestamps: true, versionKey: false, }
);

let roleModel = model("Otp", otpSchema, "Otp");

module.exports = roleModel;
