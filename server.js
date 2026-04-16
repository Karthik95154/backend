require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cron = require("node-cron"); // For scheduling tasks

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

const DEFAULT_SPOT_COLUMNS = 4;
const ACTIVE_BOOKING_STATUSES = ["Pending", "Paid"];
const GRACE_PERIOD_MINUTES = 15;

/* ================= PARKING SCHEMA ================= */
const parkingSchema = new mongoose.Schema({
  name: String,
  slots: Number,
  price: Number,
  latitude: Number,
  longitude: Number,
  layoutName: String,
  spots: [
    {
      spotId: String,
      label: String,
      row: Number,
      column: Number,
      type: String,
    },
  ],
});

const Parking = mongoose.model("Parking", parkingSchema);

/* ================= USER SCHEMA ================= */
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  password: String,
});

const User = mongoose.model("User", userSchema);

/* ================= BOOKING SCHEMA ================= */
const bookingSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  userPhone: String,
  userEmail: String,
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
  
  // Slot assignment tracking
  slotAssigned: { type: Boolean, default: false },
  slotAssignedAt: { type: Date, default: null },
  slotAssignmentMessageSent: { type: Boolean, default: false },
  
  // Check-in/out tracking
  checkInTime: { type: Date, default: null },
  checkOutTime: { type: Date, default: null },
  
  // Status tracking
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Failed', 'Refunded'],
    default: 'Pending'
  },
  bookingStatus: {
    type: String,
    enum: ['Confirmed', 'SlotAssigned', 'Checked-In', 'Completed', 'Cancelled', 'NoShow', 'Extended'],
    default: 'Confirmed'
  },
  
  // Payment details
  razorpay_order_id: String,
  razorpay_payment_id: String,
  receiptUrl: String,
  qrData: String,
  
  // Time extension tracking
  extendedMinutes: { type: Number, default: 0 },
  extraCharge: { type: Number, default: 0 },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

bookingSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Booking = mongoose.model("Booking", bookingSchema);

/* ================= SLOT TRACKING SCHEMA ================= */
// Track which slot is assigned to which booking at what time
const slotAssignmentSchema = new mongoose.Schema({
  parkingId: String,
  spotId: String,
  spotLabel: String,
  bookingId: String,
  vehicleNumber: String,
  startTime: Date,
  endTime: Date,
  isActive: { type: Boolean, default: true },
  assignedAt: { type: Date, default: Date.now }
});

const SlotAssignment = mongoose.model("SlotAssignment", slotAssignmentSchema);

/* ================= HELPER FUNCTIONS ================= */

// Get all currently occupied slots for a parking lot at a specific time
const getOccupiedSlotsAtTime = async (parkingId, targetTime) => {
  const targetDateTime = new Date(targetTime);
  
  // Find all active assignments that cover this time
  const activeAssignments = await SlotAssignment.find({
    parkingId: String(parkingId),
    isActive: true,
    startTime: { $lte: targetDateTime },
    endTime: { $gt: targetDateTime }
  });
  
  return activeAssignments.map(assignment => ({
    spotId: assignment.spotId,
    spotLabel: assignment.spotLabel,
    bookingId: assignment.bookingId
  }));
};

// Get available slots for a specific time
const getAvailableSlotsAtTime = async (parkingId, targetTime) => {
  const parking = await Parking.findById(parkingId);
  if (!parking) return [];
  
  const allSpots = normalizeParkingSpots(parking);
  const occupiedSlots = await getOccupiedSlotsAtTime(parkingId, targetTime);
  const occupiedSpotIds = new Set(occupiedSlots.map(s => s.spotId));
  
  const availableSlots = allSpots.filter(spot => !occupiedSpotIds.has(spot.spotId));
  
  return availableSlots;
};

// Assign a specific slot to a booking
const assignSlotToBooking = async (bookingId, spotId, spotLabel) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found");
  
  // Check if slot is actually available
  const availableSlots = await getAvailableSlotsAtTime(booking.parkingId, booking.startTime);
  const isSlotAvailable = availableSlots.some(slot => slot.spotId === spotId);
  
  if (!isSlotAvailable) {
    throw new Error("Slot is no longer available");
  }
  
  // Create slot assignment
  const assignment = new SlotAssignment({
    parkingId: booking.parkingId,
    spotId: spotId,
    spotLabel: spotLabel,
    bookingId: booking._id,
    vehicleNumber: booking.vehicleNumber,
    startTime: booking.startTime,
    endTime: booking.endTime,
    isActive: true
  });
  
  await assignment.save();
  
  // Update booking
  booking.spotId = spotId;
  booking.spotLabel = spotLabel;
  booking.slotAssigned = true;
  booking.slotAssignedAt = new Date();
  booking.bookingStatus = "SlotAssigned";
  await booking.save();
  
  return assignment;
};

// Auto-assign best available slot
const autoAssignSlot = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found");
  
  const availableSlots = await getAvailableSlotsAtTime(booking.parkingId, booking.startTime);
  
  if (availableSlots.length === 0) {
    throw new Error("No slots available for the selected time");
  }
  
  // Assign the first available slot (can be optimized - nearest to entrance, etc.)
  const selectedSlot = availableSlots[0];
  
  await assignSlotToBooking(bookingId, selectedSlot.spotId, selectedSlot.label);
  
  return selectedSlot;
};

// Send SMS/Notification to user (placeholder - integrate with SMS service)
const sendSlotAssignmentNotification = async (booking) => {
  // TODO: Integrate with SMS service like Twilio, AWS SNS, or Firebase Cloud Messaging
  console.log(`📱 SENDING NOTIFICATION to ${booking.userPhone}:`);
  console.log(`   Your parking slot ${booking.spotLabel} is assigned for ${booking.parkingName}`);
  console.log(`   Time: ${new Date(booking.startTime).toLocaleString()}`);
  console.log(`   Vehicle: ${booking.vehicleNumber}`);
  
  // In production, implement actual SMS:
  // await twilioClient.messages.create({
  //   body: `Your parking slot ${booking.spotLabel} is assigned at ${booking.parkingName}. Valid from ${booking.startTime}`,
  //   to: booking.userPhone,
  //   from: process.env.TWILIO_PHONE_NUMBER
  // });
  
  booking.slotAssignmentMessageSent = true;
  await booking.save();
};

// Release slot after check-out or expiry
const releaseSlot = async (bookingId) => {
  const assignment = await SlotAssignment.findOne({ 
    bookingId: bookingId, 
    isActive: true 
  });
  
  if (assignment) {
    assignment.isActive = false;
    await assignment.save();
    console.log(`Slot ${assignment.spotLabel} released for booking ${bookingId}`);
  }
};

// Auto-assign slots 15 minutes before booking time
const processPendingSlotAssignments = async () => {
  console.log("🔄 Checking for bookings needing slot assignment...");
  
  const now = new Date();
  const assignmentWindow = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes from now
  
  const pendingBookings = await Booking.find({
    paymentStatus: "Paid",
    slotAssigned: false,
    bookingStatus: "Confirmed",
    startTime: { $lte: assignmentWindow, $gt: now }, // Within next 15 minutes
    slotAssignmentMessageSent: false
  });
  
  for (const booking of pendingBookings) {
    try {
      console.log(`📌 Assigning slot for booking ${booking._id} (Vehicle: ${booking.vehicleNumber})`);
      
      // Check availability again before assigning
      const availableSlots = await getAvailableSlotsAtTime(booking.parkingId, booking.startTime);
      
      if (availableSlots.length === 0) {
        console.log(`❌ No slots available for booking ${booking._id}`);
        // Handle no availability - maybe offer refund or alternative
        booking.bookingStatus = "Cancelled";
        await booking.save();
        continue;
      }
      
      // Assign slot
      const assignedSlot = await autoAssignSlot(booking._id);
      
      // Send notification
      await sendSlotAssignmentNotification(booking);
      
      console.log(`✅ Slot ${assignedSlot.label} assigned to ${booking.vehicleNumber}`);
    } catch (error) {
      console.error(`Error assigning slot for booking ${booking._id}:`, error);
    }
  }
};

// Auto-cancel no-show bookings after grace period
const autoCancelNoShowBookings = async () => {
  const now = new Date();
  const gracePeriodMs = GRACE_PERIOD_MINUTES * 60 * 1000;
  
  const noShowBookings = await Booking.find({
    bookingStatus: { $in: ['Confirmed', 'SlotAssigned'] },
    paymentStatus: 'Paid',
    startTime: { $lt: new Date(now - gracePeriodMs) },
    checkInTime: null
  });
  
  for (const booking of noShowBookings) {
    booking.bookingStatus = 'NoShow';
    await booking.save();
    
    // Release the slot if it was assigned
    await releaseSlot(booking._id);
    
    console.log(`Booking ${booking._id} marked as NoShow, slot released`);
  }
};

// Handle expired slot assignments (bookings that ended but not checked out)
const handleExpiredBookings = async () => {
  const now = new Date();
  
  const expiredBookings = await Booking.find({
    bookingStatus: { $in: ['SlotAssigned', 'Checked-In'] },
    paymentStatus: 'Paid',
    endTime: { $lt: now },
    checkOutTime: null
  });
  
  for (const booking of expiredBookings) {
    // Auto check-out if expired
    const extraMs = now - booking.endTime;
    const extraHours = Math.ceil(extraMs / (60 * 60 * 1000));
    const extraCharge = extraHours * booking.pricePerHour;
    
    booking.checkOutTime = now;
    booking.bookingStatus = 'Completed';
    booking.extendedMinutes = extraHours * 60;
    booking.extraCharge = extraCharge;
    await booking.save();
    
    // Release slot
    await releaseSlot(booking._id);
    
    console.log(`Booking ${booking._id} auto-checked out. Extra charge: ₹${extraCharge}`);
  }
};

/* ================= SCHEDULED TASKS ================= */
// Run every minute to check for slot assignments
setInterval(processPendingSlotAssignments, 60 * 1000);

// Run every 5 minutes to check for no-shows
setInterval(autoCancelNoShowBookings, 5 * 60 * 1000);

// Run every minute to handle expired bookings
setInterval(handleExpiredBookings, 60 * 1000);

/* ================= PARKING HELPER FUNCTIONS ================= */
const getSpotLabel = (index, columns = DEFAULT_SPOT_COLUMNS) => {
  const rowIndex = Math.floor(index / columns);
  const columnIndex = (index % columns) + 1;
  const rowLetter = String.fromCharCode(65 + (rowIndex % 26));
  const rowSuffix = rowIndex >= 26 ? Math.floor(rowIndex / 26) : "";
  return `${rowLetter}${rowSuffix}${columnIndex}`;
};

const buildFallbackSpots = (slotCount = 0, columns = DEFAULT_SPOT_COLUMNS) =>
  Array.from({ length: Math.max(0, Number(slotCount) || 0) }, (_, index) => ({
    spotId: `spot-${index + 1}`,
    label: getSpotLabel(index, columns),
    row: Math.floor(index / columns) + 1,
    column: (index % columns) + 1,
    type: index % columns === 1 || index % columns === 2 ? "standard" : "compact",
  }));

const normalizeParkingSpots = (parking) => {
  const rawSpots = Array.isArray(parking?.spots) ? parking.spots : [];

  if (rawSpots.length === 0) {
    return buildFallbackSpots(parking?.slots);
  }

  return rawSpots
    .map((spot, index) => ({
      spotId: String(spot?.spotId || `spot-${index + 1}`),
      label: String(spot?.label || getSpotLabel(index)).toUpperCase(),
      row: Number(spot?.row) || Math.floor(index / DEFAULT_SPOT_COLUMNS) + 1,
      column: Number(spot?.column) || (index % DEFAULT_SPOT_COLUMNS) + 1,
      type: String(spot?.type || "standard"),
    }))
    .sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      return a.column - b.column;
    });
};

const serializeParking = (parking) => {
  const data = parking.toObject ? parking.toObject() : parking;
  const spots = normalizeParkingSpots(data);
  return {
    ...data,
    slots: spots.length || Number(data?.slots) || 0,
    spots,
  };
};

/* ================= PARKING ENDPOINTS ================= */

// Get all parking with real-time available slots
app.get("/parking", async (req, res) => {
  try {
    const data = await Parking.find();
    const parkingWithAvailability = await Promise.all(
      data.map(async (parking) => {
        const availableSlots = await getAvailableSlotsAtTime(parking._id, new Date());
        return {
          ...serializeParking(parking),
          availableSlotsCount: availableSlots.length,
          totalSlots: parking.slots
        };
      })
    );
    res.json(parkingWithAvailability);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch parking data" });
  }
});

// Get available slots for a specific time range
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
    
    // Check if booking is at least 15 minutes in advance
    const minStartTime = new Date(Date.now() + 15 * 60 * 1000);
    if (start < minStartTime) {
      return res.status(400).json({ 
        message: "Booking must be at least 15 minutes in advance" 
      });
    }
    
    const availableSlots = await getAvailableSlotsAtTime(parking._id, start);
    const occupiedSlots = await getOccupiedSlotsAtTime(parking._id, start);
    
    const parkingData = serializeParking(parking);
    
    res.json({
      ...parkingData,
      availableSlotsCount: availableSlots.length,
      occupiedSlotsCount: occupiedSlots.length,
      totalSlots: parking.slots,
      availableSlots: availableSlots,
      startTime: start,
      endTime: end,
      canBook: availableSlots.length > 0
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

// Create booking (payment pending, no slot assigned yet)
app.post("/book", async (req, res) => {
  try {
    const {
      userId,
      userName,
      userPhone,
      userEmail,
      vehicleNumber,
      parkingId,
      parkingName,
      hours,
      pricePerHour,
      totalAmount,
      startTime,
      endTime
    } = req.body;
    
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
    
    // Check if booking is at least 15 minutes in advance
    const minStartTime = new Date(Date.now() + 15 * 60 * 1000);
    if (parsedStartTime < minStartTime) {
      return res.status(400).json({ 
        message: "Booking must be at least 15 minutes in advance" 
      });
    }
    
    // Check availability for the requested time
    const availableSlots = await getAvailableSlotsAtTime(parkingId, parsedStartTime);
    
    if (availableSlots.length === 0) {
      return res.status(409).json({ 
        message: "No slots available for the selected time" 
      });
    }
    
    const parking = await Parking.findById(parkingId);
    const finalAmount = totalAmount || (hours * (pricePerHour || parking.price));
    
    const booking = new Booking({
      userId,
      userName: userName || "User",
      userPhone: userPhone || "",
      userEmail: userEmail || "",
      vehicleNumber: vehicleNumber.toUpperCase(),
      parkingId,
      parkingName: parkingName || parking.name,
      hours,
      pricePerHour: pricePerHour || parking.price,
      totalAmount: finalAmount,
      startTime: parsedStartTime,
      endTime: parsedEndTime,
      paymentStatus: "Pending",
      bookingStatus: "Confirmed",
      slotAssigned: false
    });
    
    await booking.save();
    
    res.json({ 
      success: true, 
      booking,
      message: "Booking created. Please complete payment."
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
      amount: booking.totalAmount * 100,
      currency: "INR",
      receipt: `booking_${booking._id}`,
      notes: {
        bookingId: booking._id.toString(),
        vehicleNumber: booking.vehicleNumber
      }
    };
    
    const order = await razorpay.orders.create(options);
    
    booking.razorpay_order_id = order.id;
    await booking.save();
    
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Verify payment and generate receipt
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
    
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(body)
      .digest("hex");
    
    const isValid = expectedSignature === razorpay_signature;
    
    if (isValid) {
      // Generate receipt URL (in production, generate PDF)
      const receiptUrl = `https://yourdomain.com/receipt/${booking._id}`;
      
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
      booking.receiptUrl = receiptUrl;
      booking.qrData = qrData;
      await booking.save();
      
      // Slot will be assigned automatically 15 minutes before start time
      // User will receive SMS notification at that time
      
      res.json({ 
        success: true, 
        message: "Payment verified successfully",
        booking: {
          id: booking._id,
          receiptUrl: booking.receiptUrl,
          qrData: booking.qrData,
          message: "Slot will be assigned 15 minutes before your booking time. You will receive SMS notification."
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

// Check-in (verify slot assignment and allow entry)
app.post("/check-in/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Check if payment is completed
    if (booking.paymentStatus !== "Paid") {
      return res.status(400).json({ message: "Payment not completed" });
    }
    
    // Check if within grace period (15 min before to 15 min after)
    const now = new Date();
    const graceStart = new Date(booking.startTime.getTime() - 15 * 60 * 1000);
    const graceEnd = new Date(booking.startTime.getTime() + GRACE_PERIOD_MINUTES * 60 * 1000);
    
    if (now < graceStart) {
      return res.status(400).json({ 
        message: `Check-in available from ${graceStart.toLocaleTimeString()}` 
      });
    }
    
    if (now > graceEnd) {
      booking.bookingStatus = "NoShow";
      await booking.save();
      await releaseSlot(booking._id);
      return res.status(400).json({ message: "Check-in time expired" });
    }
    
    // Verify slot is assigned
    if (!booking.slotAssigned) {
      // Try to assign slot now if not assigned
      try {
        await autoAssignSlot(booking._id);
        await sendSlotAssignmentNotification(booking);
      } catch (error) {
        return res.status(409).json({ message: "No slots available at this moment" });
      }
    }
    
    // Verify slot is still available (no conflict)
    const occupiedSlots = await getOccupiedSlotsAtTime(booking.parkingId, now);
    const isSlotOccupied = occupiedSlots.some(slot => slot.spotId === booking.spotId);
    
    if (isSlotOccupied) {
      // Slot conflict - assign new slot
      console.log(`⚠️ Slot conflict for ${booking.spotLabel}. Re-assigning...`);
      try {
        const newSlot = await autoAssignSlot(booking._id);
        await sendSlotAssignmentNotification(booking);
        booking.spotLabel = newSlot.label;
        await booking.save();
      } catch (error) {
        return res.status(409).json({ message: "No slots available. Please contact staff." });
      }
    }
    
    // Check-in
    booking.checkInTime = now;
    booking.bookingStatus = "Checked-In";
    await booking.save();
    
    res.json({
      success: true,
      message: "Checked in successfully",
      spotLabel: booking.spotLabel,
      spotId: booking.spotId,
      vehicleNumber: booking.vehicleNumber,
      validUntil: booking.endTime
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Check-out with time extension handling
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
    let extended = false;
    
    // Calculate extra charges if checked out late
    if (now > booking.endTime) {
      const extraMs = now - booking.endTime;
      extraHours = Math.ceil(extraMs / (60 * 60 * 1000));
      extraCharge = extraHours * booking.pricePerHour;
      extended = true;
      
      booking.extendedMinutes = extraHours * 60;
      booking.extraCharge = extraCharge;
      booking.bookingStatus = "Extended";
    } else {
      booking.bookingStatus = "Completed";
    }
    
    booking.checkOutTime = now;
    await booking.save();
    
    // Release the slot
    await releaseSlot(booking._id);
    
    res.json({
      success: true,
      message: extended ? "Checked out with extension" : "Checked out successfully",
      spotLabel: booking.spotLabel,
      originalAmount: booking.totalAmount,
      extraHours,
      extraCharge,
      totalAmount: booking.totalAmount + extraCharge,
      extended
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Extend booking time
app.post("/extend-booking/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { additionalHours } = req.body;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    if (booking.bookingStatus !== "Checked-In") {
      return res.status(400).json({ message: "Can only extend active bookings" });
    }
    
    const newEndTime = new Date(booking.endTime.getTime() + additionalHours * 60 * 60 * 1000);
    const extraCharge = additionalHours * booking.pricePerHour;
    
    // Update slot assignment end time
    await SlotAssignment.findOneAndUpdate(
      { bookingId: booking._id, isActive: true },
      { endTime: newEndTime }
    );
    
    // Update booking
    booking.endTime = newEndTime;
    booking.hours += additionalHours;
    booking.totalAmount += extraCharge;
    booking.extendedMinutes += additionalHours * 60;
    booking.extraCharge += extraCharge;
    await booking.save();
    
    res.json({
      success: true,
      message: `Booking extended by ${additionalHours} hours`,
      newEndTime: booking.endTime,
      extraCharge,
      newTotal: booking.totalAmount
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

// Cancel booking
app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Check if cancellation is allowed (30 min before start time)
    const now = new Date();
    const cancelDeadline = new Date(booking.startTime.getTime() - 30 * 60 * 1000);
    
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
    
    // Release slot if assigned
    if (booking.slotAssigned) {
      await releaseSlot(booking._id);
    }
    
    await booking.save();
    
    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get slot occupancy for a parking lot
app.get("/admin/parking/:id/occupancy", async (req, res) => {
  try {
    const { time } = req.query;
    const checkTime = time ? new Date(time) : new Date();
    
    const occupiedSlots = await getOccupiedSlotsAtTime(req.params.id, checkTime);
    const parking = await Parking.findById(req.params.id);
    const allSpots = normalizeParkingSpots(parking);
    
    res.json({
      parkingId: req.params.id,
      parkingName: parking.name,
      checkTime,
      totalSlots: allSpots.length,
      occupiedSlots: occupiedSlots.length,
      availableSlots: allSpots.length - occupiedSlots.length,
      occupiedList: occupiedSlots,
      occupancyRate: ((occupiedSlots.length / allSpots.length) * 100).toFixed(2) + '%'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
  console.log("✅ Smart Parking System Initialized");
  console.log("📌 Features:");
  console.log("   - Dynamic slot assignment 15 min before booking");
  console.log("   - SMS notifications for slot assignment");
  console.log("   - Real-time availability checking");
  console.log("   - Conflict prevention (offline + online)");
  console.log("   - Time extension handling");
  console.log("   - Auto no-show cancellation");
});
