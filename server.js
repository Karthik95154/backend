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

const ACTIVE_BOOKING_STATUSES = ["Pending", "Paid", "Active"];
const GRACE_PERIOD_MINUTES = 15; // 15 minutes grace period

/* ================= PARKING SCHEMA (Simplified) ================= */
const parkingSchema = new mongoose.Schema({
  name: String,
  totalSlots: Number,  // Total number of parking slots
  availableSlots: Number, // Dynamically updated
  pricePerHour: Number,
  latitude: Number,
  longitude: Number,
  address: String,
  openingTime: String, // "06:00"
  closingTime: String, // "22:00"
  isOpen: { type: Boolean, default: true }
});

const Parking = mongoose.model("Parking", parkingSchema);

/* ================= USER SCHEMA ================= */
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  password: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

/* ================= BOOKING SCHEMA (Dynamic Slots) ================= */
const bookingSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  userEmail: String,
  phone: String,
  vehicleNumber: String,
  parkingId: String,
  parkingName: String,
  
  // Dynamic slot allocation - no fixed spotId
  slotNumber: { type: Number, default: null }, // Allocated at check-in
  hours: Number,
  pricePerHour: Number,
  totalAmount: Number,
  
  // Time management
  startTime: Date,     // Booking start time
  endTime: Date,       // Booking end time
  checkInTime: { type: Date, default: null },  // Actual check-in time
  checkOutTime: { type: Date, default: null }, // Actual check-out time
  
  // Status tracking
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Failed', 'Refunded'],
    default: 'Pending'
  },
  bookingStatus: {
    type: String,
    enum: ['Confirmed', 'Checked-In', 'Completed', 'Cancelled', 'NoShow'],
    default: 'Confirmed'
  },
  
  // Payment details
  razorpay_order_id: String,
  razorpay_payment_id: String,
  
  // QR Data for check-in
  qrData: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-update updatedAt
bookingSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Booking = mongoose.model("Booking", bookingSchema);

/* ================= HELPER FUNCTIONS ================= */

// Calculate available slots at a given time
const getAvailableSlotsAtTime = async (parkingId, targetTime) => {
  const targetDateTime = new Date(targetTime);
  
  // Find all active bookings that overlap with the target time
  const activeBookings = await Booking.find({
    parkingId: String(parkingId),
    paymentStatus: { $in: ['Paid', 'Pending'] },
    bookingStatus: { $in: ['Confirmed', 'Checked-In'] },
    startTime: { $lte: targetDateTime },
    endTime: { $gt: targetDateTime }
  });
  
  const bookedSlots = activeBookings.length;
  
  const parking = await Parking.findById(parkingId);
  if (!parking) return 0;
  
  const totalSlots = parking.totalSlots;
  const availableSlots = Math.max(0, totalSlots - bookedSlots);
  
  return availableSlots;
};

// Check if parking is open at given time
const isParkingOpen = (parking, checkTime) => {
  const hours = checkTime.getHours();
  const minutes = checkTime.getMinutes();
  const currentTime = hours * 60 + minutes;
  
  const [openHour, openMinute] = parking.openingTime.split(':').map(Number);
  const [closeHour, closeMinute] = parking.closingTime.split(':').map(Number);
  
  const openTime = openHour * 60 + openMinute;
  const closeTime = closeHour * 60 + closeMinute;
  
  return currentTime >= openTime && currentTime <= closeTime;
};

// Auto-cancel no-show bookings after grace period
const autoCancelNoShowBookings = async () => {
  const now = new Date();
  const gracePeriodMs = GRACE_PERIOD_MINUTES * 60 * 1000;
  
  const noShowBookings = await Booking.find({
    bookingStatus: 'Confirmed',
    paymentStatus: 'Paid',
    startTime: { $lt: new Date(now - gracePeriodMs) },
    checkInTime: null
  });
  
  for (const booking of noShowBookings) {
    booking.bookingStatus = 'NoShow';
    await booking.save();
    console.log(`Booking ${booking._id} marked as NoShow`);
  }
};

// Run auto-cancel every 5 minutes
setInterval(autoCancelNoShowBookings, 5 * 60 * 1000);

/* ================= PARKING ENDPOINTS ================= */

// Get all parking lots
app.get("/parking", async (req, res) => {
  try {
    const parkingLots = await Parking.find();
    
    // Update available slots for each parking
    const parkingWithAvailability = await Promise.all(
      parkingLots.map(async (parking) => {
        const availableSlots = await getAvailableSlotsAtTime(parking._id, new Date());
        return {
          ...parking.toObject(),
          availableSlots,
          isOpen: isParkingOpen(parking, new Date())
        };
      })
    );
    
    res.json(parkingWithAvailability);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch parking data" });
  }
});

// Get specific parking availability for a time range
app.get("/parking/:id/availability", async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);
    if (!parking) {
      return res.status(404).json({ message: "Parking not found" });
    }
    
    const { startTime, endTime } = req.query;
    
    if (!startTime || !endTime) {
      return res.status(400).json({ message: "Start time and end time required" });
    }
    
    const start = new Date(startTime);
    const end = new Date(endTime);
    
    if (start >= end) {
      return res.status(400).json({ message: "End time must be after start time" });
    }
    
    // Check if parking is open during requested time
    if (!isParkingOpen(parking, start) || !isParkingOpen(parking, end)) {
      return res.status(400).json({ 
        message: `Parking is only open from ${parking.openingTime} to ${parking.closingTime}` 
      });
    }
    
    // Find all bookings that overlap with the requested time
    const overlappingBookings = await Booking.find({
      parkingId: String(parking._id),
      paymentStatus: { $in: ['Paid', 'Pending'] },
      bookingStatus: { $in: ['Confirmed', 'Checked-In'] },
      startTime: { $lt: end },
      endTime: { $gt: start }
    });
    
    const bookedSlots = overlappingBookings.length;
    const availableSlots = Math.max(0, parking.totalSlots - bookedSlots);
    
    res.json({
      ...parking.toObject(),
      availableSlots,
      bookedSlots,
      totalSlots: parking.totalSlots,
      startTime: start,
      endTime: end,
      isOpen: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= USER ENDPOINTS ================= */

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
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }
    
    if (user.password !== password) {
      return res.status(400).json({ message: "Wrong password" });
    }
    
    res.json({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= BOOKING ENDPOINTS ================= */

// Create booking (without allocating specific slot)
app.post("/book", async (req, res) => {
  try {
    const {
      userId,
      userName,
      userEmail,
      phone,
      vehicleNumber,
      parkingId,
      parkingName,
      hours,
      pricePerHour,
      totalAmount,
      startTime,
      endTime
    } = req.body;
    
    // Validation
    if (!userId || !vehicleNumber || !parkingId) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    
    const vehicleRegex = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/i;
    if (!vehicleRegex.test(vehicleNumber)) {
      return res.status(400).json({ message: "Invalid vehicle number format" });
    }
    
    const parsedStartTime = new Date(startTime);
    const parsedEndTime = new Date(endTime);
    
    if (parsedStartTime >= parsedEndTime) {
      return res.status(400).json({ message: "Invalid time range" });
    }
    
    // Check if start time is within next 15 minutes
    const minStartTime = new Date(Date.now() + 15 * 60 * 1000);
    if (parsedStartTime < minStartTime) {
      return res.status(400).json({ 
        message: "Booking must be at least 15 minutes in advance" 
      });
    }
    
    // Check availability
    const parking = await Parking.findById(parkingId);
    if (!parking) {
      return res.status(404).json({ message: "Parking not found" });
    }
    
    const availableSlots = await getAvailableSlotsAtTime(parkingId, parsedStartTime);
    
    if (availableSlots <= 0) {
      return res.status(409).json({ 
        message: "No slots available for the selected time" 
      });
    }
    
    // Create booking (slot will be allocated at check-in)
    const booking = new Booking({
      userId,
      userName: userName || "User",
      userEmail: userEmail || "",
      phone: phone || "N/A",
      vehicleNumber: vehicleNumber.toUpperCase(),
      parkingId,
      parkingName,
      hours,
      pricePerHour: pricePerHour || parking.pricePerHour,
      totalAmount: totalAmount || (hours * (pricePerHour || parking.pricePerHour)),
      startTime: parsedStartTime,
      endTime: parsedEndTime,
      paymentStatus: "Pending",
      bookingStatus: "Confirmed"
    });
    
    await booking.save();
    
    res.json({ 
      success: true, 
      booking,
      message: "Booking created successfully"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create Razorpay order
app.post("/create-order", async (req, res) => {
  try {
    const { bookingId } = req.body;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    const options = {
      amount: booking.totalAmount * 100, // Convert to paise
      currency: "INR",
      receipt: `booking_${booking._id}`,
      notes: {
        bookingId: booking._id.toString(),
        vehicleNumber: booking.vehicleNumber
      }
    };
    
    const order = await razorpay.orders.create(options);
    
    // Save order ID to booking
    booking.razorpay_order_id = order.id;
    await booking.save();
    
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Verify payment
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId
    } = req.body;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    
    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(body)
      .digest("hex");
    
    const isValid = expectedSignature === razorpay_signature;
    
    if (isValid) {
      // Generate QR data for check-in
      const qrData = JSON.stringify({
        bookingId: booking._id,
        parkingName: booking.parkingName,
        vehicleNumber: booking.vehicleNumber,
        amount: booking.totalAmount,
        startTime: booking.startTime,
        endTime: booking.endTime
      });
      
      booking.paymentStatus = "Paid";
      booking.razorpay_payment_id = razorpay_payment_id;
      booking.qrData = qrData;
      await booking.save();
      
      res.json({ 
        success: true, 
        message: "Payment verified successfully",
        booking: {
          id: booking._id,
          qrData: booking.qrData
        }
      });
    } else {
      res.status(400).json({ success: false, message: "Payment verification failed" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// CHECK-IN: Allocate slot number at actual arrival
app.post("/check-in/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { slotNumber } = req.body; // Optionally specify slot number
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Check if booking is paid
    if (booking.paymentStatus !== "Paid") {
      return res.status(400).json({ message: "Payment not completed" });
    }
    
    // Check if already checked in
    if (booking.bookingStatus === "Checked-In") {
      return res.status(400).json({ message: "Already checked in" });
    }
    
    // Check if within grace period
    const now = new Date();
    const gracePeriodEnd = new Date(booking.startTime.getTime() + GRACE_PERIOD_MINUTES * 60000);
    
    if (now > gracePeriodEnd) {
      booking.bookingStatus = "NoShow";
      await booking.save();
      return res.status(400).json({ message: "Check-in time expired" });
    }
    
    // Find available slot number
    let allocatedSlot = slotNumber;
    if (!allocatedSlot) {
      // Get all occupied slots for current time
      const activeBookings = await Booking.find({
        parkingId: booking.parkingId,
        paymentStatus: "Paid",
        bookingStatus: "Checked-In",
        checkInTime: { $ne: null },
        checkOutTime: null
      });
      
      const occupiedSlots = activeBookings.map(b => b.slotNumber).filter(s => s);
      const parking = await Parking.findById(booking.parkingId);
      
      // Find first available slot
      for (let i = 1; i <= parking.totalSlots; i++) {
        if (!occupiedSlots.includes(i)) {
          allocatedSlot = i;
          break;
        }
      }
      
      if (!allocatedSlot) {
        return res.status(409).json({ message: "No slots available at this moment" });
      }
    }
    
    // Update booking
    booking.slotNumber = allocatedSlot;
    booking.checkInTime = now;
    booking.bookingStatus = "Checked-In";
    await booking.save();
    
    res.json({
      success: true,
      message: "Checked in successfully",
      slotNumber: allocatedSlot,
      booking
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// CHECK-OUT: Release slot
app.post("/check-out/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    if (booking.bookingStatus !== "Checked-In") {
      return res.status(400).json({ message: "Not checked in" });
    }
    
    const now = new Date();
    let extraHours = 0;
    let extraCharge = 0;
    
    // Calculate extra charges if checked out late
    if (now > booking.endTime) {
      const extraMs = now - booking.endTime;
      extraHours = Math.ceil(extraMs / (60 * 60 * 1000));
      extraCharge = extraHours * booking.pricePerHour;
    }
    
    booking.checkOutTime = now;
    booking.bookingStatus = "Completed";
    await booking.save();
    
    res.json({
      success: true,
      message: "Checked out successfully",
      extraHours,
      extraCharge,
      totalPaid: booking.totalAmount + extraCharge
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get user bookings
app.get("/my-bookings/:userId", async (req, res) => {
  try {
    const bookings = await Booking.find({
      userId: req.params.userId
    }).sort({ startTime: -1 });
    
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get booking details
app.get("/booking/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel booking (refund if within time)
app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Check if cancellation is allowed
    const now = new Date();
    const cancelDeadline = new Date(booking.startTime.getTime() - 30 * 60 * 1000); // 30 min before
    
    if (now > cancelDeadline && booking.paymentStatus === "Paid") {
      return res.status(400).json({ 
        message: "Cannot cancel less than 30 minutes before start time" 
      });
    }
    
    if (booking.bookingStatus === "Checked-In") {
      return res.status(400).json({ message: "Cannot cancel after check-in" });
    }
    
    booking.bookingStatus = "Cancelled";
    if (booking.paymentStatus === "Pending") {
      booking.paymentStatus = "Failed";
    }
    
    await booking.save();
    
    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all bookings
app.get("/admin/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ startTime: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update parking slots
app.put("/admin/parking/:id", async (req, res) => {
  try {
    const { totalSlots, pricePerHour, openingTime, closingTime } = req.body;
    const parking = await Parking.findByIdAndUpdate(
      req.params.id,
      { totalSlots, pricePerHour, openingTime, closingTime },
      { new: true }
    );
    res.json(parking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize sample parking data
app.post("/init-parking", async (req, res) => {
  try {
    const sampleParking = new Parking({
      name: "Uppal Parking",
      totalSlots: 50,
      pricePerHour: 15,
      latitude: 17.3850,
      longitude: 78.4867,
      address: "Uppal, Hyderabad",
      openingTime: "06:00",
      closingTime: "22:00"
    });
    
    await sampleParking.save();
    res.json({ message: "Sample parking created", parking: sampleParking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
