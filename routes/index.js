const app = require("express")();
const env = require("../config/env.config");


app.get("/", (req, res) => res.send(`Welcome to ${env.PROJECT_NAME} APIs!`));


app.use("/role", require("./role.routes"));
app.use("/user", require("./user.routes"));
app.use("/trade", require("./trade.routes"));


module.exports = app;