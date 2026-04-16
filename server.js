require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

/* ================= DB ================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Atlas connected ✅"))
  .catch((err) => console.log("Mongo Error:", err));

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
});

/* ================= MODELS ================= */

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  password: String,
});
const User = mongoose.model("User", userSchema);

const bookingSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  phone: String,
  vehicleNumber: String,
  parkingId: String,
  parkingName: String,
  spotId: String,
  spotLabel: String,
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

/* ================= AUTH ================= */

app.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = new User({ name, email, phone, password });
    await user.save();

    res.json({ message: "Signup successful", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.trim() });

    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.password !== password)
      return res.status(400).json({ message: "Wrong password" });

    res.json({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= BOOKING ================= */

app.post("/book", async (req, res) => {
  try {
    const booking = new Booking(req.body);
    await booking.save();
    res.json({ booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= CREATE ORDER ================= */

app.post("/create-order", async (req, res) => {
  try {
    const { bookingId } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const order = await razorpay.orders.create({
      amount: booking.totalAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // ✅ SAVE ORDER ID (FIX)
    booking.razorpay_order_id = order.id;
    await booking.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= VERIFY PAYMENT ================= */

app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId,
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(body)
      .digest("hex");

    console.log("EXPECTED:", expectedSignature);
    console.log("RECEIVED:", razorpay_signature);

    if (expectedSignature === razorpay_signature) {
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      // ✅ ORDER MATCH CHECK (FIX)
      if (booking.razorpay_order_id !== razorpay_order_id) {
        return res
          .status(400)
          .json({ success: false, error: "Order mismatch" });
      }

      const qrData = JSON.stringify({
        bookingId: booking._id,
        vehicle: booking.vehicleNumber,
        amount: booking.totalAmount,
      });

      booking.paymentStatus = "Paid";
      booking.razorpay_payment_id = razorpay_payment_id;
      booking.qrData = qrData;

      await booking.save();

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: "Invalid signature" });
    }
  } catch (err) {
    console.log("VERIFY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= BOOKINGS ================= */

app.get("/my-bookings/:userId", async (req, res) => {
  const bookings = await Booking.find({ userId: req.params.userId });
  res.json(bookings);
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
