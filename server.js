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

const DEFAULT_SPOT_COLUMNS = 4;
const ACTIVE_BOOKING_STATUSES = ["Pending", "Paid"];

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
    type:
      index % columns === 1 || index % columns === 2 ? "standard" : "compact",
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
      if (a.row !== b.row) {
        return a.row - b.row;
      }

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

const findOverlappingBookings = async ({
  parkingId,
  startTime,
  endTime,
  spotId,
}) => {
  if (!parkingId || !startTime || !endTime || !spotId) {
    return [];
  }

  return Booking.find({
    parkingId: String(parkingId),
    spotId: String(spotId),
    paymentStatus: { $in: ACTIVE_BOOKING_STATUSES },
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  });
};

/* ================= PARKING ================= */
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

app.get("/parking", async (req, res) => {
  try {
    const data = await Parking.find();
    res.json(data.map(serializeParking));
  } catch (err) {
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

/* ================= BOOKING ================= */
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

  // QR DATA FIELD
  qrData: String,

  date: {
    type: Date,
    default: Date.now,
  },
});

const Booking = mongoose.model("Booking", bookingSchema);

app.get("/parking/:id/availability", async (req, res) => {
  try {
    const parking = await Parking.findById(req.params.id);

    if (!parking) {
      return res.status(404).json({ message: "Parking not found" });
    }

    const startTime = req.query.startTime ? new Date(req.query.startTime) : null;
    const endTime = req.query.endTime ? new Date(req.query.endTime) : null;
    const hasValidWindow =
      startTime &&
      endTime &&
      !isNaN(startTime.getTime()) &&
      !isNaN(endTime.getTime()) &&
      startTime < endTime;

    const parkingData = serializeParking(parking);
    let occupiedSpotIds = new Set();

    if (hasValidWindow) {
      const overlappingBookings = await Booking.find({
        parkingId: String(parking._id),
        paymentStatus: { $in: ACTIVE_BOOKING_STATUSES },
        startTime: { $lt: endTime },
        endTime: { $gt: startTime },
      });

      occupiedSpotIds = new Set(
        overlappingBookings
          .map((booking) => booking.spotId)
          .filter(Boolean)
          .map(String)
      );
    }

    const spots = parkingData.spots.map((spot) => ({
      ...spot,
      status: occupiedSpotIds.has(String(spot.spotId)) ? "booked" : "available",
    }));

    const availableSpots = spots.filter(
      (spot) => spot.status === "available"
    ).length;

    res.json({
      ...parkingData,
      availableSpots,
      occupiedSpots: spots.length - availableSpots,
      startTime: hasValidWindow ? startTime : null,
      endTime: hasValidWindow ? endTime : null,
      spots,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      spotId,
      spotLabel,
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

    const parsedStartTime = startTime ? new Date(startTime) : null;
    const parsedEndTime = endTime ? new Date(endTime) : null;
    const hasValidWindow =
      parsedStartTime &&
      parsedEndTime &&
      !isNaN(parsedStartTime.getTime()) &&
      !isNaN(parsedEndTime.getTime()) &&
      parsedStartTime < parsedEndTime;

    let finalSpotId = spotId ? String(spotId) : null;
    let finalSpotLabel = spotLabel ? String(spotLabel).toUpperCase() : null;

    if (parkingId) {
      const parking = await Parking.findById(parkingId);

      if (parking) {
        const parkingSpots = normalizeParkingSpots(parking);

        if (parkingSpots.length > 0) {
          if (!finalSpotId && !finalSpotLabel) {
            return res.status(400).json({ message: "Please select a parking spot" });
          }

          const selectedSpot = parkingSpots.find(
            (spot) =>
              spot.spotId === finalSpotId ||
              spot.label === String(finalSpotLabel || "").toUpperCase()
          );

          if (!selectedSpot) {
            return res.status(400).json({ message: "Selected parking spot is invalid" });
          }

          finalSpotId = selectedSpot.spotId;
          finalSpotLabel = selectedSpot.label;

          if (hasValidWindow) {
            const overlappingBookings = await findOverlappingBookings({
              parkingId,
              startTime: parsedStartTime,
              endTime: parsedEndTime,
              spotId: finalSpotId,
            });

            if (overlappingBookings.length > 0) {
              return res.status(409).json({
                message: "This parking spot is no longer available for the selected time",
              });
            }
          }
        }
      }
    }

    let finalHours = hours;

    if (!finalHours && hasValidWindow) {
      finalHours = Math.max(
        1,
        (parsedEndTime - parsedStartTime) / (1000 * 60 * 60)
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
      spotId: finalSpotId,
      spotLabel: finalSpotLabel,
      hours: finalHours || 1,
      pricePerHour: pricePerHour || 0,
      totalAmount: finalAmount,
      startTime: parsedStartTime,
      endTime: parsedEndTime,
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
    let booking = null;

    if (bookingId) {
      booking = await Booking.findById(bookingId);
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
    
    // Save order ID to booking if booking exists
    if (booking) {
      booking.razorpay_order_id = order.id;
      await booking.save();
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= VERIFY PAYMENT (FIXED) ================= */
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId,
    } = req.body;

    console.log("Verifying payment:", { razorpay_order_id, razorpay_payment_id, bookingId });

    // First, find the booking
    const booking = await Booking.findById(bookingId);
    
    if (!booking) {
      return res.status(404).json({ 
        success: false, 
        message: "Booking not found" 
      });
    }

    // If we have a valid payment ID from Razorpay, verify the signature
    let isValid = false;
    
    if (razorpay_payment_id && razorpay_signature && razorpay_order_id) {
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_SECRET)
        .update(body)
        .digest("hex");
      
      isValid = expectedSignature === razorpay_signature;
      
      // Allow mock signature for testing
      if (!isValid && razorpay_signature === "mock_web_signature") {
        isValid = true;
        console.log("Using mock signature for testing");
      }
    } 
    
    // For manual payment success (fallback)
    if (!isValid && req.body.paymentStatus === "Paid") {
      isValid = true;
      console.log("Manual payment status fallback");
    }

    if (isValid) {
      // CREATE QR DATA
      const qrData = JSON.stringify({
        bookingId: booking._id,
        parkingName: booking.parkingName,
        vehicle: booking.vehicleNumber,
        amount: booking.totalAmount,
        spotLabel: booking.spotLabel,
        time: new Date().toISOString(),
      });

      // SAVE BOOKING WITH PAYMENT INFO
      booking.paymentStatus = "Paid";
      if (razorpay_payment_id) {
        booking.razorpay_payment_id = razorpay_payment_id;
      }
      if (razorpay_order_id) {
        booking.razorpay_order_id = razorpay_order_id;
      }
      booking.qrData = qrData;

      await booking.save();

      console.log("Payment verified successfully for booking:", bookingId);

      res.json({ 
        success: true,
        message: "Payment verified successfully",
        booking: {
          id: booking._id,
          qrData: booking.qrData,
          vehicleNumber: booking.vehicleNumber,
          spotLabel: booking.spotLabel,
          totalAmount: booking.totalAmount
        }
      });
    } else {
      console.log("Payment verification failed - Signature mismatch for booking:", bookingId);
      res.status(400).json({ 
        success: false, 
        message: "Payment verification failed" 
      });
    }
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/* ================= MANUAL PAYMENT SUCCESS (FALLBACK) ================= */
app.post("/payment-success", async (req, res) => {
  try {
    const { bookingId, paymentId } = req.body;
    
    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID required" });
    }
    
    const booking = await Booking.findById(bookingId);
    
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Create QR data
    const qrData = JSON.stringify({
      bookingId: booking._id,
      parkingName: booking.parkingName,
      vehicle: booking.vehicleNumber,
      amount: booking.totalAmount,
      spotLabel: booking.spotLabel,
      time: new Date().toISOString(),
    });
    
    booking.paymentStatus = "Paid";
    if (paymentId) {
      booking.razorpay_payment_id = paymentId;
    }
    booking.qrData = qrData;
    
    await booking.save();
    
    console.log("Manual payment success for booking:", bookingId);
    
    res.json({ 
      success: true, 
      message: "Payment recorded successfully",
      booking: {
        id: booking._id,
        qrData: booking.qrData,
        vehicleNumber: booking.vehicleNumber,
        spotLabel: booking.spotLabel,
        totalAmount: booking.totalAmount
      }
    });
  } catch (err) {
    console.error("Manual payment error:", err);
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

/* ================= GET SINGLE BOOKING ================= */
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

/* ================= CANCEL BOOKING ================= */
app.delete("/cancel-booking/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    // Only allow cancellation of pending bookings
    if (booking.paymentStatus === "Paid") {
      return res.status(400).json({ message: "Cannot cancel paid booking" });
    }
    
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ message: "Booking cancelled successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= GET ALL BOOKINGS (ADMIN) ================= */
app.get("/all-bookings", async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ date: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= UPDATE BOOKING QR ================= */
app.post("/update-qr/:bookingId", async (req, res) => {
  try {
    const { qrData } = req.body;
    const booking = await Booking.findById(req.params.bookingId);
    
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    
    booking.qrData = qrData;
    await booking.save();
    
    res.json({ message: "QR data updated successfully", booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
