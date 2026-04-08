const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= DB CONNECTION ================= */
mongoose
  .connect("mongodb+srv://karthik:Karthik951%40@cluster0.auw8xop.mongodb.net/parkingDB")
  .then(() => console.log("MongoDB Atlas connected ✅"))
  .catch((err) => console.log(err));

/* ================= RAZORPAY SETUP ================= */
const RAZORPAY_KEY_ID = "rzp_test_SYvFiZFRu1TNNt";
const RAZORPAY_SECRET = "sAsdpro7nRKW5STE1n6FQtlx";

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_SECRET,
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
  const data = await Parking.find();
  res.json(data);
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
    res.status(500).json({ error: err.message });
  }
});

/* ================= LOGIN ================= */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email, password });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    res.json({ message: "Login successful", user });
  } catch (err) {
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

  // 🔥 NEW FIELD
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

/* ================= CREATE ORDER ================= */
app.post("/create-order", async (req, res) => {
  try {
    const { bookingId, amount } = req.body;

    let finalAmount = amount;

    if (bookingId) {
      const booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      finalAmount = booking.totalAmount;
    }

    if (!finalAmount) {
      return res.status(400).json({ message: "Amount required" });
    }

    const options = {
      amount: finalAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= VERIFY PAYMENT (UPDATED) ================= */
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
      .createHmac("sha256", RAZORPAY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      // 🔳 CREATE QR DATA
      const qrData = JSON.stringify({
        bookingId: booking._id,
        parkingName: booking.parkingName,
        vehicle: booking.vehicleNumber,
        amount: booking.totalAmount,
        time: new Date(),
      });

      // 💾 SAVE
      booking.paymentStatus = "Paid";
      booking.razorpay_payment_id = razorpay_payment_id;
      booking.qrData = qrData;

      await booking.save();

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= GET BOOKINGS ================= */
app.get("/my-bookings/:userId", async (req, res) => {
  try {
    const bookings = await Booking.find({
      userId: req.params.userId,
    }).sort({ date: -1 });

    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= CANCEL BOOKING ================= */
app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
app.listen(5000, "0.0.0.0", () => {
  console.log("Server running on port 5000 🚀");
});