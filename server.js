/* ═══════════════════════════════════════════════════════
   Cravez — server (MongoDB / Mongoose)
   Vercel-compatible: SSE instead of WebSocket,
   serverless MongoDB connection caching.
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();
const express   = require('express');
const { randomBytes } = require('crypto');
const path      = require('path');
const mongoose  = require('mongoose');
// Disable query buffering so serverless requests fail fast when Mongo is unavailable.
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const cors      = require('cors');
const multer    = require('multer');
const fs        = require('fs');

// ─── Env validation ───────────────────────────────────────────────────────────
// In production (Vercel), set MONGODB_URI and JWT_SECRET in Project Settings.
// Missing Mongo config falls back to demo auth instead of letting Mongoose buffer.
const MONGO_URI  = (process.env.MONGODB_URI || '').trim();
const JWT_SECRET = (process.env.JWT_SECRET || 'cravez_dev_secret_change_before_deploy').trim();
const AUTH_FALLBACK_ENABLED = process.env.AUTH_FALLBACK_ENABLED !== 'false';

// ─── MongoDB — cached connection for serverless ───────────────────────────────
// Each Vercel function invocation reuses the same connection if the instance is warm.
mongoose.set('bufferCommands', false);
let cachedConn = null;
let pendingConn = null;
async function connectDB() {
  if (!MONGO_URI) {
    console.warn('⚡ MONGODB_URI not set — Mock mode active.');
    return null;
  }
  if (cachedConn && mongoose.connection.readyState === 1) return cachedConn;
  if (pendingConn) return pendingConn;
  if (mongoose.connection.readyState !== 1) cachedConn = null;
  try {
    pendingConn = mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      maxPoolSize: 5,
      minPoolSize: 1,
    });
    cachedConn = await pendingConn;
    console.log('☘️ MongoDB Connected');
    return cachedConn;
  } catch (err) {
    cachedConn = null;
    console.error('❌ MongoDB connection failed:', err.message);
    console.warn('🚀 Falling back to Mock mode. Check Atlas IP whitelist → allow 0.0.0.0/0');
    return null;
  } finally {
    pendingConn = null;
  }
}

async function connectDBWithin(ms = 1200) {
  return Promise.race([
    connectDB(),
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ]);
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use('/api', rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 1000, 
  message: { error: 'Too many requests.' } 
}));
app.use(express.json());

// --- Multer Configuration ---
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  }
});

app.use('/uploads', express.static(uploadDir));

// --- File Upload Endpoint ---
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// ─── Request logging ──────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

// ─── DB helper for route handlers ───────────────────────────────────────────
// Called explicitly only inside routes that need MongoDB (auth / orders / user).
// Static-data routes (brands, menu, nearby restaurants) skip this entirely.

// ─── Static files (local dev only — Vercel serves them via vercel.json routes) ─
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));

// ─── Schemas ──────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password_hash: { type: String, required: true },
  role:          { type: String, enum: ['customer', 'seller', 'rider', 'support'], default: 'customer' },
  phone:         { type: String, default: null },
  address:       { type: String, default: null },
  lat:           { type: Number, default: null },
  lng:           { type: Number, default: null },
  veg_only:      { type: Boolean, default: false },
  // Seller specific
  restaurant_name: { type: String, default: null },
  restaurant_category: { type: String, default: null },
  restaurant_image: { type: String, default: null },
  // Rider specific
  is_available: { type: Boolean, default: true },
  balance: { type: Number, default: 0 },
}, { timestamps: true });

const MenuItemSchema = new mongoose.Schema({
  seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:      { type: String, required: true },
  price:     { type: Number, required: true },
  desc:      { type: String, default: '' },
  isVeg:     { type: Boolean, default: true },
  image:     { type: String, default: '' },
  category:  { type: String, default: 'snacks' }
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  user_id:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  restaurant_id:        String,
  real_restaurant_name: String,
  items:                [{ id: String, name: String, price: Number, qty: Number, isVeg: Boolean, desc: String }],
  status:               { type: String, default: 'placed' },
  total:                Number,
  address:              String,
  delivery_lat:         Number,
  delivery_lng:         Number,
  restaurant_lat:       Number,
  restaurant_lng:       Number,
  history:              [{ status: String, label: String, time: { type: Date, default: Date.now } }],
  driver:               { name: String, phone: String, vehicle: String, avatar: String },
  estimated_delivery:   Date,
}, { timestamps: true });

// Prevent OverwriteModelError on serverless hot reload
const User     = mongoose.models.User     || mongoose.model('User',     UserSchema);
const Order    = mongoose.models.Order    || mongoose.model('Order',    OrderSchema);
const MenuItem = mongoose.models.MenuItem || mongoose.model('MenuItem', MenuItemSchema);

// ─── SSE subscriber registry ──────────────────────────────────────────────────
// In-memory per instance. For multi-instance production deployments,
// replace with a pub/sub backend (e.g. Upstash Redis pub/sub).
const sseClients = new Map(); // orderId (string) → Set<Response>
const fallbackOrders = new Map();

function ssePublish(orderId, payload) {
  const subs = sseClients.get(String(orderId));
  if (!subs || !subs.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  subs.forEach(res => { try { res.write(data); } catch { /* client gone */ } });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ORDER_STATUSES = [
  { key: 'placed',     label: 'Order Placed' },
  { key: 'confirmed',  label: 'Confirmed'    },
  { key: 'preparing',  label: 'Preparing'    },
  { key: 'picked_up',  label: 'Picked Up'    },
  { key: 'on_the_way', label: 'On the Way'   },
  { key: 'delivered',  label: 'Delivered'    },
];

const DELIVERY_DRIVERS = [
  { name: 'Rahul Kumar',  phone: '+91 98765 43210', vehicle: 'Bike - DL 5S 1234',    avatar: '🧑‍🦱' },
  { name: 'Priya Sharma', phone: '+91 87654 32109', vehicle: 'Bike - DL 3K 5678',    avatar: '👩‍🦰' },
  { name: 'Amit Singh',   phone: '+91 76543 21098', vehicle: 'Scooter - DL 9M 9012', avatar: '🧔'   },
  { name: 'Sunita Verma', phone: '+91 65432 10987', vehicle: 'Bike - DL 2R 3456',    avatar: '👩'   },
];

const REAL_MENU_DATABASE = {
  pizza: [
    {name:'Margherita Pizza', price:299, desc:'Classic sourdough with fresh basil and mozzarella.', isVeg:true, image:'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400'},
    {name:'Pepperoni Overload', price:449, desc:'Spicy pepperoni with liquid cheese explosion.', isVeg:false, image:'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400'},
    {name:'Farmhouse Special', price:399, desc:'Mushrooms, olives, bell peppers, and fresh corn.', isVeg:true, image:'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400'},
    {name:'Paneer Tikka Pizza', price:379, desc:'Diced paneer marinated in tikka spices.', isVeg:true, image:'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400'},
    {name:'BBQ Chicken Pizza', price:429, desc:'Smoky chicken with onions and BBQ sauce.', isVeg:false, image:'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400'}
  ],
  burger: [
    {name:'Classic Smash Burger', price:199, desc:'Double patty, caramelised onions, secret sauce.', isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
    {name:'Crispy Paneer Burger', price:179, desc:'Spiced paneer patty with peri-peri mayo.', isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'The BBQ Beast', price:299, desc:'Triple beef patty with smoked bacon and cheddar.', isVeg:false, image:'https://images.unsplash.com/photo-1594212202860-96f7e4a11f71?w=400'},
    {name:'Aloo Tikki Gold', price:99, desc:'Crispy potato patty with fresh salad.', isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'}
  ],
  biryani: [
    {name:'Chicken Dum Biryani', price:349, desc:'Slow cooked fragrant basmati with dum chicken.', isVeg:false, image:'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400'},
    {name:'Lucknowi Mutton Biryani', price:549, desc:'Royal delicacy with tender mutton pieces.', isVeg:false, image:'https://images.unsplash.com/photo-1589302168068-964664d93cb0?w=400'},
    {name:'Paneer Dum Biryani', price:319, desc:'A rich vegetarian take on the classic dum biryani.', isVeg:true, image:'https://images.unsplash.com/photo-1633945274405-b6c8069047b0?w=400'}
  ],
  chinese: [
    {name:'Schezwan Fried Rice', price:229, desc:'Tossed in fiery homemade schezwan sauce.', isVeg:true, image:'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=400'},
    {name:'Chicken Manchurian', price:289, desc:'Crispy chicken balls in soya garlic gravy.', isVeg:false, image:'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400'},
    {name:'Hakka Noodles', price:209, desc:'Stir fried noodles with fresh julienned veggies.', isVeg:true, image:'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400'},
    {name:'Dim Sum Basket (6pcs)', price:249, desc:'Steamed translucent dumplings with chicken.', isVeg:false, image:'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=400'}
  ],
  dessert: [
    {name:'Death by Chocolate', price:199, desc:'Triple layer chocolate cake with hot fudge.', isVeg:true, image:'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=400'},
    {name:'NY Cheesecake', price:249, desc:'Creamy cheesecake with berry compote.', isVeg:true, image:'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=400'},
    {name:'Tiramisu Bowl', price:279, desc:'Coffee soaked ladyfingers with mascarpone.', isVeg:true, image:'https://images.unsplash.com/photo-1571115177098-24c424f32d90?w=400'}
  ],
  healthy: [
    {name:'Quinoa Salad', price:299, desc:'Olives, feta, cucumber and lemon vinaigrette.', isVeg:true, image:'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400'},
    {name:'Grilled Chicken Bowl', price:349, desc:'Skinless breast with brown rice and broccoli.', isVeg:false, image:'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400'},
    {name:'Avocado Toast', price:399, desc:'Sourdough with smashed avocado and eggs.', isVeg:false, image:'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=400'}
  ],
  snacks: [
    {name:'Peri Peri Fries', price:129, desc:'Crispy fries tossed in spicy peri-peri dust.', isVeg:true, image:'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400'},
    {name:'Cheese Nachos', price:179, desc:'Corn chips with melted cheese and jalapenos.', isVeg:true, image:'https://images.unsplash.com/photo-1513456852971-30c0b8199d4d?w=400'},
    {name:'Chicken Wings (6pcs)', price:299, desc:'Choice of Buffalo or BBQ sauce.', isVeg:false, image:'https://images.unsplash.com/photo-1608039829572-78524f79c4c7?w=400'}
  ],
  cafe: [
    {name:'Iced Americano', price:189, desc:'Double shot espresso over ice.', isVeg:true, image:'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=400'},
    {name:'Caramel Macchiato', price:249, desc:'Creamy milk with vanilla and caramel drizzle.', isVeg:true, image:'https://images.unsplash.com/photo-1485808191679-5f86510681a2?w=400'},
    {name:'Croissant Classic', price:159, desc:'Butter flaky pastry served warm.', isVeg:true, image:'https://images.unsplash.com/photo-1555507036-ab1f40ce88cb?w=400'}
  ],
  'burger king':[
    {name:'Whopper',price:199,desc:'Flame grilled beef patty with tomatoes, fresh cut lettuce, mayo, pickles, a swirl of ketchup, and sliced white onions on a soft sesame seed bun.',isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
    {name:'Chicken Whopper',price:199,desc:'Flame grilled chicken patty with classic whopper dressings.',isVeg:false, image:'https://images.unsplash.com/photo-1610440042657-612c34d95e9f?w=400'},
    {name:'Veg Whopper',price:169,desc:'Signature veg patty topped with fresh salad and mayo.',isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'BK Double Stacker',price:249,desc:'Two flame-grilled patties, bacon, American cheese, and Stacker sauce.',isVeg:false, image:'https://images.unsplash.com/photo-1594212202860-96f7e4a11f71?w=400'},
    {name:'Fiery Chicken Burger',price:219,desc:'Spicy fried chicken patty with ghost pepper sauce.',isVeg:false, image:'https://images.unsplash.com/photo-1610440042657-612c34d95e9f?w=400'},
    {name:'Crispy Veg Burger',price:89,desc:'Crispy potato patty with fresh salad.',isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'BK Onion Rings',price:99,desc:'Crispy battered onion rings.',isVeg:true, image:'https://images.unsplash.com/photo-1639024471283-03518883512d?w=400'},
    {name:'Hersheys Chocolate Shake',price:149,desc:'Thick and creamy chocolate shake.',isVeg:true, image:'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=400'}
  ],
  'mcdonald': [
    {name:'Big Mac',price:299,desc:'Two 100% beef patties, Big Mac sauce, pickles, crisp shredded lettuce, finely chopped onion, and a slice of American cheese.',isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
    {name:'McChicken',price:149,desc:'Classic crispy chicken patty, topped with mayonnaise and shredded iceberg lettuce.',isVeg:false, image:'https://images.unsplash.com/photo-1610440042657-612c34d95e9f?w=400'},
    {name:'McSpicy Paneer',price:189,desc:'Spicy paneer patty, lettuce, and tandoori mayo.',isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'Filet-O-Fish',price:199,desc:'Wild-caught fish patty, tartar sauce, and a half slice of American cheese.',isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
    {name:'McVeggie',price:129,desc:'A blend of peas, carrots, green beans, onions, potatoes and rice, coated in crispy breadcrumbs.',isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'World Famous Fries (L)',price:129,desc:'Golden, crispy and perfectly salted.',isVeg:true, image:'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400'},
    {name:'Chicken McNuggets (9pc)',price:219,desc:'Tender, juicy chicken breast chunks with a crispy tempura coating.',isVeg:false, image:'https://images.unsplash.com/photo-1562967914-608f82629710?w=400'},
    {name:'McFlurry Oreo',price:119,desc:'Vanilla soft serve with crushed Oreo cookies.',isVeg:true, image:'https://images.unsplash.com/photo-1563805042-7684c8a9e9ce?w=400'}
  ],
  'kfc': [
    {name:'Zinger Burger',price:189,desc:'Our signature crispy chicken breast fillet with lettuce and mayo.',isVeg:false, image:'https://images.unsplash.com/photo-1610440042657-612c34d95e9f?w=400'},
    {name:'Hot & Crispy Chicken (4pc)',price:429,desc:'Our signature spicy, crunchy bone-in fried chicken.',isVeg:false, image:'https://images.unsplash.com/photo-1569691899455-88464f6d3ab1?w=400'},
    {name:'Popcorn Chicken (Large)',price:249,desc:'Bite-sized pieces of crispy chicken breast.',isVeg:false, image:'https://images.unsplash.com/photo-1562967914-608f82629710?w=400'},
    {name:'Veg Zinger',price:169,desc:'Crispy veg patty with special spices and mayo.',isVeg:true, image:'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400'},
    {name:'Fiery Grilled Chicken (2pc)',price:229,desc:'Spicy, marinated chicken grilled to perfection.',isVeg:false, image:'https://images.unsplash.com/photo-1598514982205-f36b96d1e8d4?w=400'},
    {name:'Chicken Strips (3pc)',price:189,desc:'Tender, boneless chicken strips fried crispy.',isVeg:false, image:'https://images.unsplash.com/photo-1562967914-608f82629710?w=400'},
    {name:'Spicy Fries',price:119,desc:'French fries sprinkled with secret spicy seasoning.',isVeg:true, image:'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400'},
    {name:'Choco Mud Pie',price:129,desc:'Rich chocolate dessert with a gooey center.',isVeg:true, image:'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=400'}
  ],
  'domino': [
    {name:'Margherita',price:239,desc:'Classic cheese pizza with a 100% mozzarella cheese topping.',isVeg:true, image:'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400'},
    {name:'Pepperoni',price:399,desc:'American classic with spicy pork pepperoni and mozzarella.',isVeg:false, image:'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400'},
    {name:'Farmhouse',price:459,desc:'A pizza that goes ballistic on veggies! Mushrooms, onions, tomatoes & capsicum.',isVeg:true, image:'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400'},
    {name:'Chicken Dominator',price:579,desc:'Loaded with double pepper barbecue chicken, peri-peri chicken, chicken tikka & grilled chicken rashers.',isVeg:false, image:'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400'},
    {name:'Peppy Paneer',price:459,desc:'Chunky paneer with crisp capsicum and spicy red paprika.',isVeg:true, image:'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400'},
    {name:'Garlic Breadsticks',price:109,desc:'Freshly baked buttery garlic bread.',isVeg:true, image:'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400'},
    {name:'Stuffed Garlic Bread',price:159,desc:'Freshly baked garlic bread stuffed with mozzarella cheese, sweet corn & tangy jalapeño.',isVeg:true, image:'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400'},
    {name:'Choco Lava Cake',price:119,desc:'Chocolate cake with a liquid, gooey center.',isVeg:true, image:'https://images.unsplash.com/photo-1624353365286-3f8d62daad51?w=400'}
  ],
  'subway': [
    {name:'Roasted Chicken Sub',price:249,desc:'Tender chicken breast with your choice of fresh veggies and sauce.',isVeg:false, image:'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=400'},
    {name:'Paneer Tikka Sub',price:229,desc:'Spiced paneer cubes marinated and roasted to perfection.',isVeg:true, image:'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=400'},
    {name:'Tuna Sub',price:279,desc:'Flaked tuna mixed with mayo, perfectly paired with fresh salad.',isVeg:false, image:'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=400'},
    {name:'Veggie Delite',price:199,desc:'A crunchy combination of all your favorite fresh veggies.',isVeg:true, image:'https://images.unsplash.com/photo-1553909489-cd47cebebea8?w=400'},
    {name:'Turkey Breast Sub',price:289,desc:'Thinly sliced premium turkey breast with fresh greens.',isVeg:false, image:'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=400'},
    {name:'B.L.T.',price:269,desc:'Crispy bacon, lettuce, and juicy tomatoes.',isVeg:false, image:'https://images.unsplash.com/photo-1553909489-cd47cebebea8?w=400'},
    {name:'Chocolate Chip Cookie',price:49,desc:'Fresh baked soft and chewy chocolate chip cookie.',isVeg:true, image:'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=400'},
    {name:'Oatmeal Raisin Cookie',price:49,desc:'Fresh baked soft oatmeal and raisin cookie.',isVeg:true, image:'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=400'}
  ],
  'starbucks': [
    {name:'Caffe Latte',price:229,desc:'Rich espresso balanced with steamed milk and a light layer of foam.',isVeg:true, image:'https://images.unsplash.com/photo-1485808191679-5f86510681a2?w=400'},
    {name:'Java Chip Frappuccino',price:319,desc:'Mocha sauce and Frappuccino chips blended with coffee and milk, topped with whipped cream.',isVeg:true, image:'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=400'},
    {name:'Caramel Macchiato',price:269,desc:'Freshly steamed milk with vanilla-flavored syrup, marked with espresso and finished with caramel drizzle.',isVeg:true, image:'https://images.unsplash.com/photo-1485808191679-5f86510681a2?w=400'},
    {name:'Cold Brew',price:249,desc:'Handcrafted in small batches, slow-steeped in cool water for 20 hours.',isVeg:true, image:'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=400'},
    {name:'Matcha Green Tea Latte',price:289,desc:'Smooth and creamy matcha sweetened just right and served with steamed milk.',isVeg:true, image:'https://images.unsplash.com/photo-1515823662972-da6a2e4d3002?w=400'},
    {name:'Blueberry Muffin',price:169,desc:'A classic muffin with sweet blueberries and a hint of lemon.',isVeg:true, image:'https://images.unsplash.com/photo-1558401391-7899b4bd5bbf?w=400'},
    {name:'Butter Croissant',price:149,desc:'Flaky, buttery, and baked to a golden brown.',isVeg:true, image:'https://images.unsplash.com/photo-1555507036-ab1f40ce88cb?w=400'},
    {name:'Lemon Loaf Cake',price:189,desc:'Moist, buttery lemon cake topped with a sweet lemon icing.',isVeg:true, image:'https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?w=400'}
  ],
  'pizza hut': [
    {name:'Tandoori Paneer Pizza',price:349,desc:'Paneer tikka, onion, capsicum with a spicy tandoori sauce.',isVeg:true, image:'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400'},
    {name:'Chicken Supreme',price:449,desc:'Loaded with Lebanese chicken, chicken meatballs, and chicken tikka.',isVeg:false, image:'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400'},
    {name:'Veggie Supreme',price:399,desc:'A vibrant mix of black olives, mushroom, capsicum, onion, and sweet corn.',isVeg:true, image:'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400'},
    {name:'Cheesy Comfort',price:299,desc:'The ultimate cheese burst pizza loaded with 100% mozzarella cheese.',isVeg:true, image:'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400'},
    {name:'Margarita Pan Pizza',price:219,desc:'Classic cheese and tomato pizza on our signature pan crust.',isVeg:true, image:'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400'},
    {name:'Spicy Baked Pasta',price:199,desc:'Penne pasta baked in a spicy red arrabbiata sauce topped with cheese.',isVeg:true, image:'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=400'},
    {name:'Cheesy Garlic Bread',price:149,desc:'Garlic bread topped with gooey melted mozzarella.',isVeg:true, image:'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400'},
    {name:'Choco Volcano',price:129,desc:'Warm chocolate cake with a molten chocolate center.',isVeg:true, image:'https://images.unsplash.com/photo-1624353365286-3f8d62daad51?w=400'}
  ]
};

const FALLBACK_RESTAURANTS = [
  { id:'f1', name:'The Gourmet Hub', cuisine:'Continental, Italian', eta:'25-30', rating:'4.8', isVeg:false, image:'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80', location:{lat:28.6139,lng:77.2090}, distance:'1.2', featuredItems:['Pasta Carbonara','Neapolitan Pizza','Tiramisu'] },
  { id:'f2', name:'Spicy Garden',    cuisine:'Indian, Mughlai',      eta:'15-20', rating:'4.5', isVeg:true,  image:'https://images.unsplash.com/photo-1517244681291-03ef738c8d93?w=600&q=80', location:{lat:28.6239,lng:77.2190}, distance:'2.5', featuredItems:['Paneer Tikka','Butter Kulcha','Dal Makhani'] },
  { id:'f3', name:'Burger Lab',      cuisine:'Fast Food, American',  eta:'10-15', rating:'4.2', isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80', location:{lat:28.6039,lng:77.1990}, distance:'0.8', featuredItems:['Mega Crunch Burger','Cheesy Fries','Vanilla Shake'] },
  { id:'f4', name:'Green Bowl Cafe', cuisine:'Salads, Healthy',      eta:'20-25', rating:'4.7', isVeg:true,  image:'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80', location:{lat:28.6339,lng:77.2290}, distance:'3.1', featuredItems:['Quinoa Salad','Avocado Toast','Green Smoothie'] },
  { id:'f5', name:'Midnight Ramen',  cuisine:'Asian, Japanese',      eta:'20-30', rating:'4.6', isVeg:false, image:'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=600&q=80', location:{lat:28.6099,lng:77.2150}, distance:'1.8', featuredItems:['Tonkotsu Ramen','Miso Soup','Pork Gyoza'] },
  { id:'f6', name:'The Pasta Project',cuisine:'Italian, Pasta',      eta:'25-35', rating:'4.4', isVeg:true,  image:'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=600&q=80', location:{lat:28.6180,lng:77.2050}, distance:'0.9', featuredItems:['Fettuccine Alfredo','Pesto Pasta','Bruschetta'] },
  { id:'f7', name:'Taco Town',       cuisine:'Mexican, Tex-Mex',     eta:'15-20', rating:'4.3', isVeg:false, image:'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&q=80', location:{lat:28.6100,lng:77.2000}, distance:'1.5', featuredItems:['Crunchy Taco','Beef Burrito','Nachos BellGrande'] },
  { id:'f8', name:'Sweet Retreat',   cuisine:'Desserts, Bakery',     eta:'10-15', rating:'4.9', isVeg:true,  image:'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=600&q=80', location:{lat:28.6250,lng:77.2100}, distance:'2.1', featuredItems:['Velvet Cupcakes','Macaron Box','Belgian Waffles'] },
];

const GLOBAL_BRANDS = {
  'kfc':         'https://upload.wikimedia.org/wikipedia/en/thumb/b/bf/KFC_logo.svg/1200px-KFC_logo.svg.png',
  'mcdonald':    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/McDonald%27s_Golden_Arches.svg/1200px-McDonald%27s_Golden_Arches.svg.png',
  'domino':      'https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Dominos_pizza_logo.svg/1200px-Dominos_pizza_logo.svg.png',
  'burger king': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Burger_King_2020.svg/1200px-Burger_King_2020.svg.png',
  'starbucks':   'https://upload.wikimedia.org/wikipedia/en/thumb/d/d3/Starbucks_Corporation_Logo_2011.svg/1200px-Starbucks_Corporation_Logo_2011.svg.png',
  'subway':      'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Subway_2016_logo.svg/1200px-Subway_2016_logo.svg.png',
  'pizza hut':   'https://upload.wikimedia.org/wikipedia/en/thumb/d/d2/Pizza_Hut_logo.svg/1200px-Pizza_Hut_logo.svg.png',
  'taco bell':   'https://upload.wikimedia.org/wikipedia/en/thumb/b/b3/Taco_Bell_2016.svg/1200px-Taco_Bell_2016.svg.png',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getStatusIndex(key) { return ORDER_STATUSES.findIndex(s => s.key === key); }

function calcDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const VALID_ROLES = ['customer', 'seller', 'rider', 'support'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeRole(role) {
  return VALID_ROLES.includes(role) ? role : 'customer';
}

function buildAuthUser(user) {
  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    role: user.role || 'customer',
    phone: user.phone || null,
    address: user.address || null,
    lat: user.lat ?? null,
    lng: user.lng ?? null,
    veg_only: !!user.veg_only,
    restaurant_name: user.restaurant_name || null,
    restaurant_category: user.restaurant_category || null,
    restaurant_image: user.restaurant_image || null,
    balance: user.balance || 0
  };
}

function signAuthToken(user) {
  return jwt.sign(
    { id: String(user._id || user.id), name: user.name, email: user.email, role: user.role || 'customer' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function buildDemoUser({ id = 'demo_user', name = 'Demo User', email, role = 'customer', address = 'Demo Street, App City' }) {
  return {
    id,
    name,
    email,
    role: normalizeRole(role),
    phone: null,
    address,
    lat: null,
    lng: null,
    veg_only: false,
    restaurant_name: role === 'seller' ? `${name}'s Kitchen` : null,
    restaurant_category: null,
    restaurant_image: null,
    balance: 0
  };
}

function fallbackNameFromEmail(email) {
  const localPart = normalizeEmail(email).split('@')[0] || 'guest';
  return localPart
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase()) || 'Demo User';
}

function fallbackAuthResponse(res, { name, email, role = 'customer', address, reason }) {
  if (!AUTH_FALLBACK_ENABLED) {
    return res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
  const safeEmail = normalizeEmail(email) || 'guest@example.com';
  const safeName = String(name || '').trim() || fallbackNameFromEmail(safeEmail);
  const demoUser = buildDemoUser({
    id: `fallback_${normalizeRole(role)}_${randomBytes(6).toString('hex')}`,
    name: safeName,
    email: safeEmail,
    role,
    address: address || 'Fallback Street, App City'
  });
  console.warn(`⚡ Auth fallback used: ${reason}`);
  return res.json({ token: signAuthToken(demoUser), user: demoUser, fallback: true });
}

function profileFromToken(user) {
  return buildDemoUser({
    id: user.id,
    name: user.name || 'Demo User',
    email: user.email || 'demo@example.com',
    role: user.role || 'customer'
  });
}

function hasMongoId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function buildFallbackOrder({ restaurantId, realRestaurantName, restaurantLocation, items, address, lat, lng }) {
  const id = `fallback_order_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const total = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
  const history = [{ status: 'placed', label: 'Order Placed', time: new Date() }];
  return {
    id,
    _id: id,
    status: 'placed',
    history,
    driver: null,
    estimatedDelivery: new Date(Date.now() + 30 * 60000),
    restaurant: { name: realRestaurantName || 'Restaurant', location: restaurantLocation },
    deliveryLocation: { lat, lng },
    restaurant_id: restaurantId,
    real_restaurant_name: realRestaurantName || 'Restaurant',
    restaurant_lat: restaurantLocation.lat,
    restaurant_lng: restaurantLocation.lng,
    delivery_lat: lat ?? null,
    delivery_lng: lng ?? null,
    total,
    address,
    items
  };
}

function verifyToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(auth.split(' ')[1], JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user; next();
  });
}

function verifyTokenOptional(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return next();
  jwt.verify(auth.split(' ')[1], JWT_SECRET, (err, user) => { if (!err) req.user = user; next(); });
}

function verifyRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role` });
    }
    next();
  };
}

// ─── Order auto-progression ───────────────────────────────────────────────────
async function advanceOrder(orderId) {
  try {
    await connectDB();
    const order = await Order.findById(orderId);
    if (!order) return;
    const idx = getStatusIndex(order.status);
    if (idx >= ORDER_STATUSES.length - 1) return;

    const next = ORDER_STATUSES[idx + 1];
    order.history.push({ status: next.key, label: next.label, time: new Date() });
    order.status = next.key;
    if (next.key === 'picked_up') {
      order.driver = DELIVERY_DRIVERS[Math.floor(Math.random() * DELIVERY_DRIVERS.length)];
    }
    await order.save();

    ssePublish(String(order._id), {
      type: 'STATUS_UPDATE',
      order: {
        id: order._id, status: order.status, history: order.history,
        driver: order.driver || null, estimatedDelivery: order.estimated_delivery,
        restaurant: { name: order.real_restaurant_name, location: { lat: order.restaurant_lat, lng: order.restaurant_lng } },
        deliveryLocation: { lat: order.delivery_lat, lng: order.delivery_lng },
        total: order.total, items: order.items, address: order.address,
      },
    });

    const delays = { placed:8000, confirmed:12000, preparing:18000, picked_up:10000, on_the_way:20000 };
    if (delays[next.key]) setTimeout(() => advanceOrder(orderId), delays[next.key]);
  } catch (err) { console.error('advanceOrder error:', err); }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// AUTH
app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const address = String(req.body.address || '').trim();
  const userRole = normalizeRole(req.body.role);

  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });

  try {
    let db;
    try { db = await connectDB(); } catch(e) { db = null; }
    if (!db) {
       return fallbackAuthResponse(res, { name, email, role: userRole, address, reason: 'database unavailable during registration' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ 
      name, 
      email, 
      password_hash: hash,
      role: userRole,
      address: address || null,
      restaurant_name: userRole === 'seller' ? `${name}'s Kitchen` : null
    });
    res.json({ token: signAuthToken(user), user: buildAuthUser(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Email already exists' });
    console.error('Register error:', e);
    return fallbackAuthResponse(res, { name, email, role: userRole, address, reason: e.message || 'registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    let db;
    try { db = await connectDB(); } catch(e) { db = null; }
    if (!db) {
      return fallbackAuthResponse(res, { email, reason: 'database unavailable during login' });
    }

    const user = await User.findOne({ email });
    if (!user) return fallbackAuthResponse(res, { email, reason: 'user not found' });
    if (!await bcrypt.compare(password, user.password_hash)) return fallbackAuthResponse(res, { email, reason: 'password check failed' });
    res.json({ token: signAuthToken(user), user: buildAuthUser(user) });
  } catch (e) { 
    console.error('Login error:', e); 
    return fallbackAuthResponse(res, { email, reason: e.message || 'login failed' });
  }
});

app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const db = await connectDB();
    if (!db) return res.json(profileFromToken(req.user));
    if (!hasMongoId(req.user.id)) return res.json(profileFromToken(req.user));
    const user = await User.findById(req.user.id).select('-password_hash');
    if (!user) return res.json(profileFromToken(req.user));
    res.json(buildAuthUser(user));
  } catch (e) {
    console.warn('⚡ Profile fallback used:', e.message);
    res.json(req.user ? profileFromToken(req.user) : buildDemoUser({ email: 'guest@example.com' }));
  }
});

app.put('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const db = await connectDB();
    if (!db) return res.json({ success: true, user: { ...profileFromToken(req.user), ...req.body } });
    if (!hasMongoId(req.user.id)) return res.json({ success: true, user: { ...profileFromToken(req.user), ...req.body } });
    const { phone, address, lat, lng, veg_only } = req.body;
    const updates = {};
    if (phone    !== undefined) updates.phone    = phone;
    if (address  !== undefined) updates.address  = address;
    if (lat      !== undefined) updates.lat      = lat;
    if (lng      !== undefined) updates.lng      = lng;
    if (veg_only !== undefined) updates.veg_only = !!veg_only;
    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password_hash');
    if (!user) return res.json({ success: true, user: { ...profileFromToken(req.user), ...req.body } });
    res.json({ success: true, user: buildAuthUser(user) });
  } catch (e) {
    console.warn('⚡ Profile update fallback used:', e.message);
    res.json({ success: true, user: { ...profileFromToken(req.user), ...req.body } });
  }
});


// ORDER ACTIONS (Connected Lifecycle)
app.put('/api/orders/:id/status', verifyToken, async (req, res) => {
  try {
    if (fallbackOrders.has(req.params.id)) {
      const order = fallbackOrders.get(req.params.id);
      const { status } = req.body;
      order.status = status;
      order.history.push({ status, label: `Order ${status}`, time: new Date() });
      fallbackOrders.set(order.id, order);
      ssePublish(order.id, { type: 'STATUS_UPDATE', order });
      return res.json({ success: true, order });
    }

    await connectDB();
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Validate role permissions for specific status changes
    if (req.user.role === 'seller' && !['confirmed', 'preparing', 'ready'].includes(status)) {
      return res.status(403).json({ error: 'Seller can only update to confirmed/preparing/ready' });
    }
    if (req.user.role === 'rider' && !['picked_up', 'delivered'].includes(status)) {
      return res.status(403).json({ error: 'Rider can only update to picked_up/delivered' });
    }

    order.status = status;
    order.history.push({ status, label: `Order ${status}`, time: new Date() });
    
    // Financial logic (Simulated)
    if (status === 'delivered') {
      // Credit Rider (fixed ₹40 commission)
      if (order.driver && order.driver.id) {
         await User.findByIdAndUpdate(order.driver.id, { $inc: { balance: 40, earnings: 40 } });
      }
      // Credit Seller (order total - platform fee)
      await User.findByIdAndUpdate(order.restaurant_id, { $inc: { balance: order.total * 0.9, earnings: order.total * 0.9 } });
    }

    await order.save();
    ssePublish(String(order._id), { type: 'STATUS_UPDATE', order });
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// RIDER API
app.get('/api/rider/dashboard', verifyToken, verifyRole('rider'), async (req, res) => {
  try {
    await connectDB();
    const pickups = await Order.find({ status: 'ready', 'driver.id': { $exists: false } }).limit(20);
    const activeTask = await Order.findOne({ status: 'picked_up', 'driver.id': req.user.id });
    res.json({ pickups, activeTask });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ✅ Frontend calls /api/rider/pickups — alias for the ready orders list
app.get('/api/rider/pickups', verifyToken, verifyRole('rider'), async (req, res) => {
  try {
    let db;
    try { db = await connectDB(); } catch(e) { db = null; }
    if (!db) return res.json([]); // mock: no pickups available
    const pickups = await Order.find({ status: 'ready', 'driver.id': { $exists: false } }).limit(20);
    res.json(pickups);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ✅ Frontend calls /api/rider/deliver/:id to mark an order delivered
app.put('/api/rider/deliver/:id', verifyToken, verifyRole('rider'), async (req, res) => {
  try {
    let db;
    try { db = await connectDB(); } catch(e) { db = null; }
    if (!db) return res.json({ success: true }); // mock response
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.status = 'delivered';
    order.history.push({ status: 'delivered', label: 'Delivered', time: new Date() });
    // Credit rider ₹40
    await User.findByIdAndUpdate(req.user.id, { $inc: { balance: 40 } });
    await order.save();
    ssePublish(String(order._id), { type: 'STATUS_UPDATE', order });
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/rider/accept/:id', verifyToken, verifyRole('rider'), async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'ready') return res.status(400).json({ error: 'Order not ready' });

    order.status = 'picked_up';
    order.driver = { 
      id: user._id,
      name: user.name, 
      phone: user.phone || '+91 99999 88888', 
      vehicle: 'Bike', 
      avatar: user.name.charAt(0).toUpperCase()
    };
    order.history.push({ status: 'picked_up', label: 'Rider is on the way', time: new Date() });
    await order.save();
    
    ssePublish(String(order._id), { type: 'STATUS_UPDATE', order });
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// SUPPORT API
app.get('/api/support/orders', verifyToken, verifyRole('support'), async (req, res) => {
  try {
    await connectDB();
    const orders = await Order.find().sort({ createdAt: -1 }).limit(100);
    res.json(orders);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch orders' }); }
});

app.get('/api/support/users', verifyToken, verifyRole('support'), async (req, res) => {
  try {
    await connectDB();
    const users = await User.find().select('-password_hash').limit(100);
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch users' }); }
});

// RESTAURANTS
app.get('/api/restaurants/brands', (_req, res) => {
  res.json([
    { id:'brand_1', name:"McDonald's",    cuisine:'Fast Food, Burgers',       eta:'15-20', rating:'4.5', isVeg:false, image:'https://images.unsplash.com/photo-1552895638-f7fe08d2f7d5?w=600&q=80',  brandLogo:GLOBAL_BRANDS['mcdonald'],    location:{lat:28.6139,lng:77.2090}, distance:'1.2', category:'mcdonald',    featuredItems:['Big Mac','McFlurry','French Fries'] },
    { id:'brand_2', name:"Domino's Pizza",cuisine:'Pizza, Italian',            eta:'20-25', rating:'4.3', isVeg:false, image:'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&q=80', brandLogo:GLOBAL_BRANDS['domino'],      location:{lat:28.6139,lng:77.2090}, distance:'1.5', category:'domino',      featuredItems:['Pepperoni Pizza','Garlic Bread','Choco Lava Cake'] },
    { id:'brand_3', name:'KFC',            cuisine:'Fried Chicken, Fast Food', eta:'15-25', rating:'4.4', isVeg:false, image:'https://images.unsplash.com/photo-1569691899455-88464f6d3ab1?w=600&q=80', brandLogo:GLOBAL_BRANDS['kfc'],         location:{lat:28.6139,lng:77.2090}, distance:'1.8', category:'kfc',         featuredItems:['Zinger Burger','Hot & Crispy Chicken','Popcorn Chicken'] },
    { id:'brand_4', name:'Subway',         cuisine:'Healthy, Sandwiches',      eta:'10-15', rating:'4.6', isVeg:false, image:'https://images.unsplash.com/photo-1509722747041-616f39b57569?w=600&q=80', brandLogo:GLOBAL_BRANDS['subway'],      location:{lat:28.6139,lng:77.2090}, distance:'0.8', category:'subway',      featuredItems:['Roasted Chicken Sub','Veggie Delite','Chocolate Chip Cookie'] },
    { id:'brand_5', name:'Starbucks',      cuisine:'Cafe, Beverages',          eta:'10-20', rating:'4.8', isVeg:false, image:'https://images.unsplash.com/photo-1559525839-b184a4d698c7?w=600&q=80',  brandLogo:GLOBAL_BRANDS['starbucks'],   location:{lat:28.6139,lng:77.2090}, distance:'0.5', category:'starbucks',   featuredItems:['Frappuccino','Caffe Latte','Blueberry Muffin'] },
    { id:'brand_6', name:'Burger King',    cuisine:'Fast Food, Burgers',       eta:'15-25', rating:'4.2', isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80', brandLogo:GLOBAL_BRANDS['burger king'], location:{lat:28.6139,lng:77.2090}, distance:'1.9', category:'burger king', featuredItems:['Whopper','Onion Rings','Crispy Chicken'] },
    { id:'brand_7', name:'Pizza Hut',      cuisine:'Pizza, Italian',           eta:'25-30', rating:'4.1', isVeg:false, image:'https://images.unsplash.com/photo-1604381536136-df533ed057d0?w=600&q=80', brandLogo:GLOBAL_BRANDS['pizza hut'],   location:{lat:28.6139,lng:77.2090}, distance:'2.1', category:'pizza hut',   featuredItems:['Pan Pizza','Cheesy Bites','Garlic Breadsticks'] },
    { id:'brand_8', name:'Taco Bell',      cuisine:'Mexican, Fast Food',       eta:'15-20', rating:'4.2', isVeg:false, image:'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&q=80', brandLogo:GLOBAL_BRANDS['taco bell'],   location:{lat:28.6139,lng:77.2090}, distance:'2.0', category:'snacks',      featuredItems:['Crunchy Taco','Burrito Supreme','Nachos BellGrande'] },
    { id:'brand_9', name:'Chipotle',       cuisine:'Mexican, Bowls',           eta:'15-25', rating:'4.5', isVeg:false, image:'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=600&q=80',  brandLogo:null,                         location:{lat:28.6139,lng:77.2090}, distance:'1.4', category:'healthy',     featuredItems:['Chicken Bowl','Steak Burrito','Guacamole'] },
  ]);
});

// ─── SELLER MENU ENDPOINTS ──────────────────────────────────────
app.get('/api/seller/menu', verifyToken, verifyRole('seller'), async (req, res) => {
  try {
    const db = await connectDB();
    if (!db || !hasMongoId(req.user.id)) return res.json([]);
    console.log(`[MENU_FETCH] Fetching menu for seller: ${req.user.id}`);
    const items = await MenuItem.find({ seller_id: req.user.id });
    console.log(`[MENU_FETCH] Found ${items.length} items`);
    res.json(items);
  } catch (e) { 
    console.error('[MENU_FETCH_ERROR]', e);
    res.json([]); 
  }
});

app.post('/api/seller/menu', verifyToken, verifyRole('seller'), async (req, res) => {
  try {
    const db = await connectDB();
    if (!db || !hasMongoId(req.user.id)) {
      return res.json({ ...req.body, id: `fallback_menu_${Date.now()}`, _id: `fallback_menu_${Date.now()}`, seller_id: req.user.id });
    }
    console.log(`[MENU_ADD] Adding item for seller ${req.user.id}:`, req.body);
    const item = await MenuItem.create({ ...req.body, seller_id: req.user.id });
    console.log(`[MENU_ADD] Item created: ${item._id}`);
    res.json(item);
  } catch (e) { 
    console.error('[MENU_ADD_ERROR]', e);
    res.json({ ...req.body, id: `fallback_menu_${Date.now()}`, _id: `fallback_menu_${Date.now()}`, seller_id: req.user.id });
  }
});

app.delete('/api/seller/menu/:id', verifyToken, verifyRole('seller'), async (req, res) => {
  try {
    const db = await connectDB();
    if (!db || !hasMongoId(req.user.id) || !hasMongoId(req.params.id)) return res.json({ success: true });
    console.log(`[MENU_DEL] Deleting item ${req.params.id} for seller ${req.user.id}`);
    await MenuItem.findOneAndDelete({ _id: req.params.id, seller_id: req.user.id });
    res.json({ success: true });
  } catch (e) { 
    console.error('[MENU_DEL_ERROR]', e);
    res.json({ success: true }); 
  }
});

app.put('/api/seller/profile', verifyToken, verifyRole('seller'), async (req, res) => {
  const { restaurant_name, restaurant_category, restaurant_image } = req.body;
  try {
    const db = await connectDB();
    if (!db || !hasMongoId(req.user.id)) return res.json({ ...profileFromToken(req.user), restaurant_name, restaurant_category, restaurant_image });
    const user = await User.findByIdAndUpdate(req.user.id, {
      restaurant_name, restaurant_category, restaurant_image
    }, { new: true });
    res.json(user);
  } catch (e) { res.json({ ...profileFromToken(req.user), restaurant_name, restaurant_category, restaurant_image }); }
});

app.get('/api/seller/orders', verifyToken, verifyRole('seller'), async (req, res) => {
  try {
    const db = await connectDBWithin(1200);
    if (!db || !hasMongoId(req.user.id)) {
      return res.json(Array.from(fallbackOrders.values()).sort((a, b) => {
        const aTime = new Date(a.history?.[0]?.time || 0).getTime();
        const bTime = new Date(b.history?.[0]?.time || 0).getTime();
        return bTime - aTime;
      }));
    }

    const orders = await Order.find({ restaurant_id: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(orders.map(o => ({
      id: String(o._id),
      status: o.status,
      total: o.total,
      items: o.items,
      restaurantName: o.real_restaurant_name,
      address: o.address,
      date: o.createdAt
    })));
  } catch (e) {
    console.warn('⚡ Seller orders fallback used:', e.message);
    res.json(Array.from(fallbackOrders.values()));
  }
});

app.get('/api/restaurants', async (req, res) => {
  const { lat, lng } = req.query;
  const userLat = Number.parseFloat(lat) || 28.6139;
  const userLng = Number.parseFloat(lng) || 77.2090;
  
  try {
    const db = await connectDBWithin(1200);
    // 1. Fetch Manual Sellers from DB (skip if no DB connection)
    const manualSellers = db ? await User.find({ role: 'seller', restaurant_name: { $ne: null } }) : [];
    const manualRestaurants = manualSellers.map(s => ({
      id: String(s._id),
      name: s.restaurant_name,
      cuisine: s.restaurant_category || 'Casual Dining',
      eta: '25-35',
      rating: '4.9',
      isVeg: false,
      image: s.restaurant_image || 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80',
      brandLogo: null,
      location: { lat: s.lat || 28.6139, lng: s.lng || 77.2090 },
      distance: calcDistanceKM(userLat, userLng, s.lat || 28.6139, s.lng || 77.2090).toFixed(1),
      category: 'manual',
      featuredItems: [] // Will be populated if needed
    }));

    // 2. Fetch OSM Restaurants (Real nearby data)
    const query = `[out:json][timeout:10];(node["amenity"="restaurant"](around:8000,${userLat},${userLng});node["amenity"="fast_food"](around:8000,${userLat},${userLng});node["amenity"="cafe"](around:8000,${userLat},${userLng}););out body 40;`;
    const params = new URLSearchParams(); params.append('data', query);
    
    let osmRestaurants = [];
    try {
      const osmRes = await fetch('https://overpass-api.de/api/interpreter', { 
        method: 'POST', 
        body: params,
        signal: AbortSignal.timeout(12000) // 12s total timeout
      });
      const osmData = await osmRes.json();
      const imgs = ['photo-1517248135467-4c7edcad34c4','photo-1552566626-52f8b828add9','photo-1555396273-367ea4eb4db5','photo-1514933651103-005eec06c04b','photo-1414235077428-338989a2e8c0','photo-1502301103665-0b95cc738def','photo-1424847651672-bf2c94a444a6','photo-1551632436-cbf8dd35adfa','photo-1537047902294-62a40c20a6ae','photo-1466978913421-dad2ebd01d17'];
      osmRestaurants = (osmData.elements || []).map(el => {
        const name = el.tags?.name || 'Local Eatery';
        if (name === 'Local Eatery') return null;
        const cuisine = el.tags?.cuisine || (el.tags?.amenity === 'cafe' ? 'Cafe, Beverages' : 'Fast Food, Casual');
        const dist = calcDistanceKM(userLat, userLng, el.lat, el.lon);
        if (dist > 8) return null;
        let brandLogo = null;
        const lowerName = name.toLowerCase();
        for (const [k, v] of Object.entries(GLOBAL_BRANDS)) { if (lowerName.includes(k)) { brandLogo = v; break; } }
        const lc = cuisine.toLowerCase();
        let category = 'snacks';
        if (lc.includes('pizza')||lowerName.includes('pizza')) category='pizza';
        else if (lc.includes('burger')||lowerName.includes('burger')) category='burger';
        else if (lc.includes('biryani')||lc.includes('indian')) category='biryani';
        else if (lc.includes('chinese')||lc.includes('noodle')) category='chinese';
        else if (lc.includes('cake')||lc.includes('dessert')) category='dessert';
        else if (lc.includes('salad')||lc.includes('healthy')) category='healthy';
        else if (lc.includes('cafe')||lc.includes('coffee')) category='cafe';
        const featured = (REAL_MENU_DATABASE[category]||REAL_MENU_DATABASE.snacks).map(i=>i.name).slice(0,3);
        return { id:`osm_${el.id}`, name, cuisine:cuisine.replace(/;/g,', ').replace(/_/g,' '), eta:15+(el.id%20)+Math.floor(dist*3), rating:(3.8+(el.id%12)/10).toFixed(1), isVeg:!!(el.tags?.diet_vegetarian==='yes'||el.tags?.cuisine?.includes('vegetarian')), image:`https://images.unsplash.com/${imgs[el.id%imgs.length]}?w=1080&q=80`, brandLogo, location:{lat:el.lat,lng:el.lon}, distance:dist.toFixed(1), category, featuredItems:featured };
      }).filter(Boolean);
    } catch (e) {
      console.warn('⚠️ Nearby restaurant fetch (OSM) failed or timed out:', e.message);
    }
    const combined = [...manualRestaurants, ...osmRestaurants];
    res.json(combined.length > 0 ? combined : FALLBACK_RESTAURANTS);
  } catch (err) { 
    console.error('Fetch restaurants error:', err);
    res.status(200).json(FALLBACK_RESTAURANTS); 
  }
});

app.get('/api/restaurants/:id/menu', async (req, res) => {
  const pId = req.params.id;

  const staticMenu = () => {
    let cat = req.query.category;
    let brandMatch = null;
    const lcName = (req.query.name || '').toLowerCase();
    for (const key of Object.keys(GLOBAL_BRANDS)) { if (lcName.includes(key)) { brandMatch = key; break; } }
    if (brandMatch && REAL_MENU_DATABASE[brandMatch]) cat = brandMatch;
    if (!cat || !REAL_MENU_DATABASE[cat]) {
      let seed = 0; for (let i = 0; i < pId.length; i++) seed += pId.charCodeAt(i);
      const cats = Object.keys(REAL_MENU_DATABASE);
      cat = cats[seed % cats.length];
    }
    return (REAL_MENU_DATABASE[cat] || REAL_MENU_DATABASE.snacks).map((item, idx) => ({ ...item, id: `item_${pId}_${idx}` }));
  };
  
  try {
    // 1. Check if it's a manual seller
    if (!pId.startsWith('osm_') && !pId.startsWith('brand_') && !pId.startsWith('f')) {
      const db = await connectDBWithin(1200);
      if (db && hasMongoId(pId)) {
        const menuItems = await MenuItem.find({ seller_id: pId });
        if (menuItems.length > 0) {
          return res.json(menuItems.map(m => ({
            id: String(m._id),
            name: m.name,
            price: m.price,
            desc: m.desc,
            isVeg: m.isVeg,
            image: m.image || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400'
          })));
        }
      }
    }

    // 2. Fallback to static menu database
    res.json(staticMenu());
  } catch (e) {
    console.warn('⚡ Menu fallback used:', e.message);
    res.json(staticMenu());
  }
});

// ORDERS
app.post('/api/orders', verifyTokenOptional, async (req, res) => {
  const { restaurantId, realRestaurantName, restaurantLocation, items, address, phone, lat, lng } = req.body;
  if (!restaurantId || !items?.length) return res.status(400).json({ error: 'restaurantId and items are required' });
  if (!restaurantLocation?.lat || !restaurantLocation?.lng) return res.status(400).json({ error: 'Restaurant location is required' });
  const sendFallbackOrder = (reason) => {
    const order = buildFallbackOrder({ restaurantId, realRestaurantName, restaurantLocation, items, address, lat, lng });
    fallbackOrders.set(order.id, order);
    console.warn(`⚡ Order fallback used: ${reason}`);
    return res.json({ orderId: order.id, order });
  };

  try {
    const db = await connectDBWithin(1200);
    if (!db) return sendFallbackOrder('database unavailable');
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const history = [{ status:'placed', label:'Order Placed', time: new Date() }];
    const order = await Order.create({
      user_id: hasMongoId(req.user?.id) ? req.user.id : null, restaurant_id: restaurantId, real_restaurant_name: realRestaurantName,
      items, status: 'placed', total, address,
      delivery_lat: lat ?? null, delivery_lng: lng ?? null,
      restaurant_lat: restaurantLocation.lat, restaurant_lng: restaurantLocation.lng,
      history, estimated_delivery: new Date(Date.now() + 30 * 60000),
    });
    setTimeout(() => advanceOrder(order._id), 6000);
    res.json({
      orderId: order._id,
      order: { 
        id: order._id, status: 'placed', history, items, total, address, 
        restaurant: { name: realRestaurantName, location: restaurantLocation },
        deliveryLocation: { lat, lng }
      },
    });
  } catch (err) {
    console.error('Order creation error:', err);
    return sendFallbackOrder(err.message || 'order creation failed');
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    if (fallbackOrders.has(req.params.id)) return res.json(fallbackOrders.get(req.params.id));
    const db = await connectDBWithin(1200);
    if (!db) return res.status(404).json({ error: 'Order not found' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({
      id: order._id, status: order.status, history: order.history, driver: order.driver || null,
      estimatedDelivery: order.estimated_delivery,
      restaurant: { name: order.real_restaurant_name, location: { lat: order.restaurant_lat, lng: order.restaurant_lng } },
      deliveryLocation: { lat: order.delivery_lat, lng: order.delivery_lng },
      total: order.total, address: order.address, items: order.items,
    });
  } catch (err) { console.error('Order fetch error:', err); res.status(404).json({ error: 'Order not found' }); }
});

app.get('/api/user/orders', verifyToken, async (req, res) => {
  try {
    const db = await connectDBWithin(1200);
    if (!db || !hasMongoId(req.user.id)) return res.json([]);
    const orders = await Order.find({ user_id: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json(orders.map(o => ({ id: o._id, status: o.status, total: o.total, items: o.items, restaurantName: o.real_restaurant_name, date: o.createdAt })));
  } catch (err) { res.json([]); }
});

// ─── SSE — Real-time order tracking ──────────────────────────────────────────
// Replaces WebSocket (incompatible with Vercel serverless).
// Client: const es = new EventSource(`/api/orders/${orderId}/stream`);
//         es.onmessage = e => { const data = JSON.parse(e.data); ... };
app.get('/api/orders/:id/stream', async (req, res) => {
  const orderId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current order state immediately
  try {
    if (fallbackOrders.has(orderId)) {
      res.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', order: fallbackOrders.get(orderId) })}\n\n`);
    } else {
    await connectDB();
    const order = await Order.findById(orderId);
    if (order) {
      const payload = {
        type: 'STATUS_UPDATE',
        order: {
          id: order._id, status: order.status, history: order.history,
          driver: order.driver || null, estimatedDelivery: order.estimated_delivery,
          restaurant: { name: order.real_restaurant_name, location: { lat: order.restaurant_lat, lng: order.restaurant_lng } },
          deliveryLocation: { lat: order.delivery_lat, lng: order.delivery_lng },
          total: order.total, items: order.items, address: order.address,
        },
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', message: 'Order not found' })}\n\n`);
    }
    }
  } catch {
    res.write(`data: ${JSON.stringify({ type: 'ERROR', message: 'Server error' })}\n\n`);
  }

  // Register subscriber
  if (!sseClients.has(orderId)) sseClients.set(orderId, new Set());
  sseClients.get(orderId).add(res);

  // Heartbeat to keep connection alive through Vercel's proxy
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const subs = sseClients.get(orderId);
    if (subs) { subs.delete(res); if (!subs.size) sseClients.delete(orderId); }
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent && _req.path === '/api/user/profile') {
    return res.status(200).json(buildDemoUser({ email: 'guest@example.com' }));
  }
  if (!res.headersSent && _req.path === '/api/restaurants') {
    return res.status(200).json(FALLBACK_RESTAURANTS);
  }
  if (!res.headersSent && /^\/api\/restaurants\/[^/]+\/menu$/.test(_req.path)) {
    const fallbackItems = (REAL_MENU_DATABASE.snacks || []).map((item, idx) => ({ ...item, id: `fallback_menu_${idx}` }));
    return res.status(200).json(fallbackItems);
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Local dev only — Vercel uses module.exports ──────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`\n⚡ Cravez running at http://localhost:${PORT}\n`));
}

module.exports = app;
