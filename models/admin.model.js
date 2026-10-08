const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = sequelize.define("User", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
  },
  email: {
    type: DataTypes.STRING,
    unique: true,
  },
  password: {
    type: DataTypes.STRING,
  },
  role: {
    type: DataTypes.STRING,
  },
  user_type: {
    type: DataTypes.STRING,
  },
    status: {
    type: DataTypes.STRING,
  },
    mobile: {
		type: DataTypes.STRING,
  },
  image: {
  type: DataTypes.STRING,
}
}, {
  tableName: "users",
  timestamps: true,
});

module.exports = User;