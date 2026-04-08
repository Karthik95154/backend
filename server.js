require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ROOT ROUTE ================= */
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

/* ================= DB CONNECTION ================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Atlas connected ✅"))
  .catch((err) => console.log("Mongo Error:", err));

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
});

/* ================= PARKING ================= */
const parkingSchema = new mongoose.Schema({
  name: String,
  slots: Number,
  price: Number,
  latitude: Number,
  longitude: Number,
});

const Parking = mongoose.model("Parking", parkingSchema);

app.get("/parking", async (req, res) => {
  try {
    const data = await Parking.find();
    res.json(data);
  } catch (err) {
    console.log("Parking Error:", err);
    res.status(500).json({ error: "Failed to fetch parking data" });
  }
});

/* ================= USER ================= */
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  password: String,
});

const User = mongoose.model("User", userSchema);

/* ================= SIGNUP ================= */
app.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^[6-9]\d{9}$/;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "All fields required" });
    }

    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }

    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ message: "Invalid phone number" });
    }

    const existing = await User.findOne({ email });

    if (existing) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = new User({ name, email, phone, password });
    await user.save();

    res.json({ message: "Signup successful", user });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= LOGIN ================= */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("LOGIN:", email, password);

    const user = await User.findOne({ email: email.trim() });

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    if (user.password !== password) {
      return res.status(400).json({ message: "Wrong password" });
    }

    res.json({ message: "Login successful", user });
  } catch (err) {
    console.log("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= BOOKING ================= */
const bookingSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  phone: String,
  vehicleNumber: String,
  parkingId: String,
  parkingName: String,
  hours: Number,
  pricePerHour: Number,
  totalAmount: Number,
  startTime: Date,
  endTime: Date,
  paymentStatus: {
    type: String,
    default: "Pending",
  },
  razorpay_order_id: String,
  razorpay_payment_id: String,
  qrData: String,
  date: {
    type: Date,
    default: Date.now,
  },
});

const Booking = mongoose.model("Booking", bookingSchema);

/* ================= CREATE BOOKING ================= */
app.post("/book", async (req, res) => {
  try {
    const {
      userId,
      userName,
      phone,
      vehicleNumber,
      parkingId,
      parkingName,
      hours,
      pricePerHour,
      totalAmount,
      startTime,
      endTime,
      paymentStatus,
      paymentId,
    } = req.body;

    if (!userId || !vehicleNumber) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const vehicleRegex = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/i;
    if (!vehicleRegex.test(vehicleNumber)) {
      return res.status(400).json({ message: "Invalid vehicle number" });
    }

    let finalHours = hours;

    if (!finalHours && startTime && endTime) {
      finalHours = Math.max(
        1,
        (new Date(endTime) - new Date(startTime)) / (1000 * 60 * 60)
      );
    }

    const finalAmount =
      totalAmount ||
      (finalHours && pricePerHour ? finalHours * pricePerHour : 0);

    const booking = new Booking({
      userId,
      userName: userName || "User",
      phone: phone || "N/A",
      vehicleNumber: vehicleNumber.toUpperCase(),
      parkingId,
      parkingName,
      hours: finalHours || 1,
      pricePerHour: pricePerHour || 0,
      totalAmount: finalAmount,
      startTime,
      endTime,
      paymentStatus: paymentStatus || "Pending",
      razorpay_payment_id: paymentId || null,
    });

    await booking.save();

    res.json({ booking });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});