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
  .then(async () => {
    console.log("MongoDB Atlas connected ✅");
    await initializeParkingData();
  })
  .catch((err) => console.log("Mongo Error:", err));

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
});

const ACTIVE_BOOKING_STATUSES = ["Pending", "Paid", "Active"];
const GRACE_PERIOD_MINUTES = 15;

/* ================= PARKING SCHEMA ================= */
const parkingSchema = new mongoose.Schema({
  name: String,
  totalSlots: Number,
  pricePerHour: Number,
  latitude: Number,
  longitude: Number,
  address: String,
  openingTime: String,
  closingTime: String,
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

/* ================= BOOKING SCHEMA ================= */
const bookingSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  userEmail: String,
  phone: String,
  vehicleNumber: String,
  parkingId: String,
  parkingName: String,
  
  slotNumber: { type: Number, default: null },
  hours: Number,
  pricePerHour: Number,
  totalAmount: Number,
  
  startTime: Date,
  endTime: Date,
  checkInTime: { type: Date, default: null },
  checkOutTime: { type: Date, default: null },
  
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
  
  razorpay_order_id: String,
  razorpay_payment_id: String,
  qrData: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

bookingSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Booking = mongoose.model("Booking", bookingSchema);

/* ================= HELPER FUNCTIONS ================= */

const getAvailableSlotsAtTime = async (parkingId, targetTime) => {
  const targetDateTime = new Date(targetTime);
  
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

setInterval(autoCancelNoShowBookings, 5 * 60 * 1000);

/* ================= DATA INITIALIZATION ================= */

const initializeParkingData = async () => {
  try {
    const count = await Parking.countDocuments();
    
    if (count === 0) {
      console.log("📋 No parking data found. Initializing sample data...");
      
      const sampleParkings = [
        {
          name: "Uppal Parking",
          totalSlots: 50,
          pricePerHour: 15,
          latitude: 17.3850,
          longitude: 78.4867,
          address: "Uppal Main Road, Near Metro Station, Hyderabad",
          openingTime: "06:00",
          closingTime: "22:00"
        },
        {
          name: "Hitech City Parking",
          totalSlots: 100,
          pricePerHour: 25,
          latitude: 17.4484,
          longitude: 78.3915,
          address: "Hitech City Main Road, Near Cyber Towers, Hyderabad",
          openingTime: "08:00",
          closingTime: "23:00"
        },
        {
          name: "Gachibowli Parking",
          totalSlots: 75,
          pricePerHour: 20,
          latitude: 17.4408,
          longitude: 78.3489,
          address: "Gachibowli Circle, Near Financial District, Hyderabad",
          openingTime: "07:00",
          closingTime: "21:00"
        },
        {
          name: "Secunderabad Parking",
          totalSlots: 40,
          pricePerHour: 12,
          latitude: 17.4399,
          longitude: 78.4983,
          address: "Secunderabad Railway Station Area, Hyderabad",
          openingTime: "05:00",
          closingTime: "23:00"
        },
        {
          name: "Jubilee Hills Parking",
          totalSlots: 60,
          pricePerHour: 30,
          latitude: 17.4316,
          longitude: 78.4110,
          address: "Jubilee Hills Road No 36, Hyderabad",
          openingTime: "09:00",
          closingTime: "22:00"
        }
      ];
      
      await Parking.insertMany(sampleParkings);
      console.log("✅ Sample parking data initialized!");
    } else {
      console.log(`✅ Parking data already exists (${count} parking lots)`);
    }
  } catch (err) {
    console.error("Error initializing parking data:", err);
  }
};

/* ================= MIGRATION ENDPOINT ================= */

app.post("/migrate-parking-data", async (req, res) => {
  try {
    const oldParkings = await Parking.find({});
    
    if (oldParkings.length === 0) {
      return res.json({ message: "No existing parking data found" });
    }
    
    let migrated = 0;
    
    for (const oldParking of oldParkings) {
      if (oldParking.totalSlots && !oldParking.slots && !oldParking.spots) {
        continue;
      }
      
      const totalSlots = oldParking.slots || oldParking.spots?.length || 50;
      const pricePerHour = oldParking.price || 15;
      
      oldParking.totalSlots = totalSlots;
      oldParking.pricePerHour = pricePerHour;
      oldParking.address = oldParking.address || "Address not set";
      oldParking.openingTime = oldParking.openingTime || "06:00";
      oldParking.closingTime = oldParking.closingTime || "22:00";
      
      oldParking.slots = undefined;
      oldParking.spots = undefined;
      oldParking.price = undefined;
      oldParking.layoutName = undefined;
      
      await oldParking.save();
      migrated++;
    }
    
    res.json({ 
      message: `Migration complete! ${migrated} parking records migrated`,
      migrated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= PARKING ENDPOINTS ================= */

app.get("/parking", async (req, res) => {
  try {
    const parkingLots = await Parking.find();
    
    if (parkingLots.length === 0) {
      return res.json([]);
    }
    
    const parkingWithAvailability = await Promise.all(
      parkingLots.map(async (parking) => {
        let availableSlots = 0;
        try {
          availableSlots = await getAvailableSlotsAtTime(parking._id, new Date());
        } catch (err) {
          console.error("Error calculating available slots:", err);
        }
        
        return {
          id: parking._id,
          name: parking.name,
          totalSlots: parking.totalSlots,
          availableSlots: availableSlots,
          pricePerHour: parking.pricePerHour,
          address: parking.address,
          latitude: parking.latitude,
          longitude: parking.longitude,
          openingTime: parking.openingTime,
          closingTime: parking.closingTime,
          isOpen: isParkingOpen(parking, new Date())
        };
      })
    );
    
    res.json(parkingWithAvailability);
  } catch (err) {
    console.error("Error in /parking:", err);
    res.status(500).json({ error: "Failed to fetch parking data" });
  }
});

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
    
    if (!isParkingOpen(parking, start) || !isParkingOpen(parking, end)) {
      return res.status(400).json({ 
        message: `Parking is only open from ${parking.openingTime} to ${parking.closingTime}` 
      });
    }
    
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
      id: parking._id,
      name: parking.name,
      totalSlots: parking.totalSlots,
      availableSlots,
      bookedSlots,
      pricePerHour: parking.pricePerHour,
      address: parking.address,
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
    
    const minStartTime = new Date(Date.now() + 15 * 60 * 1000);
    if (parsedStartTime < minStartTime) {
      return res.status(400).json({ 
        message: "Booking must be at least 15 minutes in advance" 
      });
    }
    
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
    
    const booking = new Booking({
      userId,
      userName: userName || "User",
      userEmail: userEmail || "",
      phone: phone || "N/A",
      vehicleNumber: vehicleNumber.toUpperCase(),
      parkingId,
      parkingName: parkingName || parking.name,
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

app.post("/check-in/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { slotNumber } = req.body;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    if (booking.paymentStatus !== "Paid") {
      return res.status(400).json({ message: "Payment not completed" });
    }
    
    if (booking.bookingStatus === "Checked-In") {
      return res.status(400).json({ message: "Already checked in" });
    }
    
    const now = new Date();
    const gracePeriodEnd = new Date(booking.startTime.getTime() + GRACE_PERIOD_MINUTES * 60000);
    
    if (now > gracePeriodEnd) {
      booking.bookingStatus = "NoShow";
      await booking.save();
      return res.status(400).json({ message: "Check-in time expired" });
    }
    
    let allocatedSlot = slotNumber;
    if (!allocatedSlot) {
      const activeBookings = await Booking.find({
        parkingId: booking.parkingId,
        paymentStatus: "Paid",
        bookingStatus: "Checked-In",
        checkInTime: { $ne: null },
        checkOutTime: null
      });
      
      const occupiedSlots = activeBookings.map(b => b.slotNumber).filter(s => s);
      const parking = await Parking.findById(booking.parkingId);
      
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

app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
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
    
    await booking.save();
    
    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= ADMIN ENDPOINTS ================= */

app.get("/admin/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ startTime: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post("/admin/add-parking", async (req, res) => {
  try {
    const { name, totalSlots, pricePerHour, latitude, longitude, address, openingTime, closingTime } = req.body;
    
    if (!name || !totalSlots || !pricePerHour) {
      return res.status(400).json({ message: "Name, totalSlots, and pricePerHour are required" });
    }
    
    const parking = new Parking({
      name,
      totalSlots,
      pricePerHour,
      latitude: latitude || 0,
      longitude: longitude || 0,
      address: address || "",
      openingTime: openingTime || "06:00",
      closingTime: closingTime || "22:00"
    });
    
    await parking.save();
    
    res.json({ message: "Parking added successfully", parking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= DEBUG ENDPOINTS ================= */

app.get("/debug/parking-raw", async (req, res) => {
  try {
    const parkings = await Parking.find({});
    
    if (parkings.length === 0) {
      return res.json({ message: "No parking data found", data: [] });
    }
    
    const sample = parkings[0];
    
    res.json({
      count: parkings.length,
      sample: {
        id: sample._id,
        name: sample.name,
        fields: Object.keys(sample.toObject()),
        data: sample.toObject()
      },
      allParkings: parkings.map(p => ({
        id: p._id,
        name: p.name,
        totalSlots: p.totalSlots,
        pricePerHour: p.pricePerHour,
        address: p.address
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset-parking-data", async (req, res) => {
  try {
    await Parking.deleteMany({});
    
    const sampleParkings = [
      {
        name: "Uppal Parking",
        totalSlots: 50,
        pricePerHour: 15,
        latitude: 17.3850,
        longitude: 78.4867,
        address: "Uppal Main Road, Near Metro Station, Hyderabad",
        openingTime: "06:00",
        closingTime: "22:00"
      },
      {
        name: "Hitech City Parking",
        totalSlots: 100,
        pricePerHour: 25,
        latitude: 17.4484,
        longitude: 78.3915,
        address: "Hitech City Main Road, Near Cyber Towers, Hyderabad",
        openingTime: "08:00",
        closingTime: "23:00"
      },
      {
        name: "Gachibowli Parking",
        totalSlots: 75,
        pricePerHour: 20,
        latitude: 17.4408,
        longitude: 78.3489,
        address: "Gachibowli Circle, Near Financial District, Hyderabad",
        openingTime: "07:00",
        closingTime: "21:00"
      }
    ];
    
    const created = await Parking.insertMany(sampleParkings);
    
    res.json({ 
      message: `Reset complete! ${created.length} parking lots created`,
      parkings: created
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
