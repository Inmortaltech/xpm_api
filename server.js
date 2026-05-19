require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const sequelize = require("./config/db");

const app = express();

// Middlewares
app.use(cors());
app.use(bodyParser.json());

const path = require("path");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
const adminRoutes = require("./routes/admin.routes");
const authRoutes = require("./routes/auth.routes");
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

// DB Sync
sequelize.sync()
  .then(() => console.log("Tables synced"))
  .catch(err => console.log(err));

// PORT fix for IIS
const port = process.env.PORT || process.env.APP_PORT || 8021;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});