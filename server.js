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
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const cors      = require('cors');

// ─── Env validation ───────────────────────────────────────────────────────────
// In production (Vercel) MONGODB_URI must be set. In dev, fall back to localhost.
if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required in production. Set it in Vercel → Settings → Environment Variables.');
}
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required in production.');
}
const MONGO_URI  = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cravez';
const JWT_SECRET = process.env.JWT_SECRET  || 'cravez_dev_secret_change_before_deploy';

// ─── MongoDB — cached connection for serverless ───────────────────────────────
// Each Vercel function invocation reuses the same connection if the instance is warm.
let cachedConn = null;
async function connectDB() {
  if (cachedConn && mongoose.connection.readyState === 1) return cachedConn;
  cachedConn = await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });
  return cachedConn;
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests.' } }));
app.use(express.json());

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
  phone:         { type: String, default: null },
  address:       { type: String, default: null },
  lat:           { type: Number, default: null },
  lng:           { type: Number, default: null },
  veg_only:      { type: Boolean, default: false },
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
const User  = mongoose.models.User  || mongoose.model('User',  UserSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// ─── SSE subscriber registry ──────────────────────────────────────────────────
// In-memory per instance. For multi-instance production deployments,
// replace with a pub/sub backend (e.g. Upstash Redis pub/sub).
const sseClients = new Map(); // orderId (string) → Set<Response>

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
  pizza:        [ { name:'Margherita Pizza',price:299,desc:'Classic sourdough with fresh basil and mozzarella.',isVeg:true},{name:'Pepperoni Overload',price:449,desc:'Spicy pepperoni with liquid cheese explosion.',isVeg:false},{name:'Farmhouse Special',price:399,desc:'Mushrooms, olives, bell peppers, and fresh corn.',isVeg:true},{name:'Paneer Tikka Pizza',price:379,desc:'Diced paneer marinated in tikka spices.',isVeg:true},{name:'BBQ Chicken Pizza',price:429,desc:'Smoky chicken with onions and BBQ sauce.',isVeg:false},{name:'Four Cheese Feast',price:479,desc:'Mozzarella, Cheddar, Parmesan, and Blue Cheese.',isVeg:true},{name:'Spicy Mexicana',price:399,desc:'Jalapenos, onions, and spicy tomato sauce.',isVeg:true},{name:'Chicken Golden Delight',price:459,desc:'Golden corn and double chicken toppings.',isVeg:false},{name:'Veggie Paradise',price:389,desc:'Baby corn, capsicum, and olives.',isVeg:true},{name:'Meat Ultra Bowl',price:549,desc:'Everything meaty: Ham, Salami, Sausages, Chicken.',isVeg:false} ],
  burger:       [ {name:'Classic Smash Burger',price:199,desc:'Double patty, caramelised onions, secret sauce.',isVeg:false},{name:'Crispy Paneer Burger',price:179,desc:'Spiced paneer patty with peri-peri mayo.',isVeg:true},{name:'The BBQ Beast',price:299,desc:'Triple beef patty with smoked bacon and cheddar.',isVeg:false},{name:'Aloo Tikki Gold',price:99,desc:'Crispy potato patty with fresh salad.',isVeg:true},{name:'Zinger Deluxe',price:249,desc:'Signature crispy chicken with spicy mayo.',isVeg:false},{name:'Veg Maharaja Mac',price:279,desc:'Double decker veg burger with special sauce.',isVeg:true},{name:'Mushroom Swiss Burger',price:319,desc:'Sauteed mushrooms with melted swiss cheese.',isVeg:true},{name:'Firehouse Chicken',price:259,desc:'Ghost pepper sauce and crispy fried chicken.',isVeg:false},{name:'Egg & Cheese Muffin',price:129,desc:'Freshly cracked egg with cheddar.',isVeg:true},{name:'Beyond Meat Burger',price:499,desc:'Plant-based patty that tastes like beef.',isVeg:true} ],
  biryani:      [ {name:'Chicken Dum Biryani',price:349,desc:'Slow cooked fragrant basmati with dum chicken.',isVeg:false},{name:'Lucknowi Mutton Biryani',price:549,desc:'Royal delicacy with tender mutton pieces.',isVeg:false},{name:'Paneer Dum Biryani',price:319,desc:'A rich vegetarian take on the classic dum biryani.',isVeg:true},{name:'Hyderabadi Egg Biryani',price:279,desc:'Spicy masala eggs with long grain rice.',isVeg:false},{name:'Veg Pulao Extreme',price:249,desc:'Medley of seasonal veggies and aromatic spices.',isVeg:true},{name:'Kolkata Chicken Biryani',price:369,desc:'Includes the iconic boiled potato and egg.',isVeg:false},{name:'Butter Chicken Biryani',price:399,desc:'Creamy butter chicken gravy met with fragrant rice.',isVeg:false},{name:'Ambur Mutton Biryani',price:529,desc:'Short grain Seeraga Samba rice with tender meat.',isVeg:false},{name:'Mushroom Biryani',price:299,desc:'Earthly mushrooms slow cooked with masalas.',isVeg:true},{name:'Raita Extra',price:49,desc:'Cool yogurt with cucumber and spices.',isVeg:true} ],
  chinese:      [ {name:'Schezwan Fried Rice',price:229,desc:'Tossed in fiery homemade schezwan sauce.',isVeg:true},{name:'Chicken Manchurian',price:289,desc:'Crispy chicken balls in soya garlic gravy.',isVeg:false},{name:'Hakka Noodles',price:209,desc:'Stir fried noodles with fresh julienned veggies.',isVeg:true},{name:'Kung Pao Chicken',price:329,desc:'Stir fried with peanuts and dried chilies.',isVeg:false},{name:'Spring Rolls (4pcs)',price:159,desc:'Crispy rolls stuffed with glass noodles and veg.',isVeg:true},{name:'Dim Sum Basket (6pcs)',price:249,desc:'Steamed translucent dumplings with chicken.',isVeg:false},{name:'Chili Paneer Dry',price:279,desc:'Cubes of paneer tossed with bell peppers.',isVeg:true},{name:'Honey Chilli Potato',price:219,desc:'Sweet and spicy crispy potato fingers.',isVeg:true},{name:'Singapore Rice Noodles',price:259,desc:'Curry flavored noodles with shrimp and veg.',isVeg:false},{name:'Sweet & Sour Chicken',price:299,desc:'Pineapple and peppers in tangy sauce.',isVeg:false} ],
  dessert:      [ {name:'Death by Chocolate',price:199,desc:'Triple layer chocolate cake with hot fudge.',isVeg:true},{name:'Gulab Jamun (2pcs)',price:79,desc:'Soft khoya balls soaked in saffron syrup.',isVeg:true},{name:'NY Cheesecake',price:249,desc:'Creamy cheesecake with berry compote.',isVeg:true},{name:'Tiramisu Bowl',price:279,desc:'Coffee soaked ladyfingers with mascarpone.',isVeg:true},{name:'Choco Lava Cake',price:129,desc:'Gooey center dark chocolate cake.',isVeg:true},{name:'Mango Sorbet',price:149,desc:'Fresh Alphonso mango frozen treat.',isVeg:true},{name:'Brownie with Ice Cream',price:189,desc:'Warm walnut brownie and vanilla scoop.',isVeg:true},{name:'Rasmalai (2pcs)',price:99,desc:'Saffron milk soaked cottage cheese discs.',isVeg:true} ],
  healthy:      [ {name:'Quinoa Salad',price:299,desc:'Olives, feta, cucumber and lemon vinaigrette.',isVeg:true},{name:'Grilled Chicken Bowl',price:349,desc:'Skinless breast with brown rice and broccoli.',isVeg:false},{name:'Avocado Toast',price:399,desc:'Sourdough with smashed avocado and eggs.',isVeg:false},{name:'Greek Yogurt Parfait',price:249,desc:'Granola, honey, and fresh seasonal berries.',isVeg:true},{name:'Detox Green Juice',price:179,desc:'Kale, spinach, apple, and lemon.',isVeg:true},{name:'Lentil Soup',price:199,desc:'High protein yellow lentils with herbs.',isVeg:true},{name:'Paneer Tofu Stir Fry',price:289,desc:'Low carb medley with spicy soy dressing.',isVeg:true},{name:'Salmon Salad',price:549,desc:'Poached salmon with asparagus and kale.',isVeg:false} ],
  snacks:       [ {name:'Peri Peri Fries',price:129,desc:'Crispy fries tossed in spicy peri-peri dust.',isVeg:true},{name:'Vada Pav Pro',price:69,desc:'Spicy potato fritter in a buttered bun.',isVeg:true},{name:'Cheese Nachos',price:179,desc:'Corn chips with melted cheese and jalapenos.',isVeg:true},{name:'Chicken Wings (6pcs)',price:299,desc:'Choice of Buffalo or BBQ sauce.',isVeg:false},{name:'Onion Rings',price:149,desc:'Beer battered crispy sweet onion rings.',isVeg:true},{name:'Garlic Bread sticks',price:129,desc:'Baked bread with herb garlic butter.',isVeg:true},{name:'Fish and Chips',price:399,desc:'Tempura battered bhetki with tartar sauce.',isVeg:false},{name:'Loaded Potato Skins',price:229,desc:'Bacon bits, sour cream, and chives.',isVeg:false} ],
  cafe:         [ {name:'Iced Americano',price:189,desc:'Double shot espresso over ice.',isVeg:true},{name:'Caramel Macchiato',price:249,desc:'Creamy milk with vanilla and caramel drizzle.',isVeg:true},{name:'Chocolate Muffin',price:129,desc:'Large moist muffin with dark choc chips.',isVeg:true},{name:'Croissant Classic',price:159,desc:'Butter flaky pastry served warm.',isVeg:true},{name:'Blueberry Cheesecake Slice',price:299,desc:'Philadelphia style with fruit topping.',isVeg:true},{name:'Cafe Latte',price:219,desc:'Steamed milk and espresso with light foam.',isVeg:true},{name:'Hazelnut Frappe',price:279,desc:'Blended coffee with hazelnut and cream.',isVeg:true},{name:'Banana Walnut Bread',price:139,desc:'Slice of toasted homemade cake.',isVeg:true} ],
  'burger king':[ {name:'Whopper',price:199,desc:'Flame grilled beef patty.',isVeg:false},{name:'Chicken Whopper',price:199,desc:'Flame grilled chicken patty.',isVeg:false},{name:'Veg Whopper',price:169,desc:'Flame grilled veg patty.',isVeg:true},{name:'Crispy Veg Burger',price:89,desc:'Crispy potato patty.',isVeg:true},{name:'Onion Rings',price:99,desc:'Crispy battered onion rings.',isVeg:true},{name:'Hersheys Chocolate Shake',price:149,desc:'Thick chocolate shake.',isVeg:true} ],
  'mcdonald':   [ {name:'Big Mac',price:299,desc:'Double patty with special sauce.',isVeg:false},{name:'McChicken',price:149,desc:'Classic crispy chicken burger.',isVeg:false},{name:'McVeggie',price:129,desc:'Classic veg burger.',isVeg:true},{name:'French Fries (Medium)',price:109,desc:'Golden crispy fries.',isVeg:true},{name:'Chicken McNuggets (6pc)',price:169,desc:'Tender juicy nuggets.',isVeg:false},{name:'McFlurry Oreo',price:119,desc:'Vanilla soft serve with Oreo.',isVeg:true} ],
  'kfc':        [ {name:'Zinger Burger',price:189,desc:'Signature crispy chicken breast.',isVeg:false},{name:'Hot & Crispy (2pc)',price:219,desc:'Spicy fried chicken.',isVeg:false},{name:'Popcorn Chicken',price:159,desc:'Bite sized crispy chicken.',isVeg:false},{name:'Veg Zinger',price:169,desc:'Crispy veg patty.',isVeg:true},{name:'Fiery Grilled Chicken',price:229,desc:'Spicy grilled chicken.',isVeg:false},{name:'Choco Mud Pie',price:129,desc:'Rich chocolate dessert.',isVeg:true} ],
  'domino':     [ {name:'Margherita',price:239,desc:'Classic cheese pizza.',isVeg:true},{name:'Pepperoni',price:399,desc:'Pork pepperoni with cheese.',isVeg:false},{name:'Farmhouse',price:459,desc:'Mushrooms, onions, tomatoes, capsicum.',isVeg:true},{name:'Chicken Dominator',price:579,desc:'Loaded with chicken tikka, spicy chicken.',isVeg:false},{name:'Garlic Breadsticks',price:109,desc:'Freshly baked garlic bread.',isVeg:true},{name:'Choco Lava Cake',price:119,desc:'Chocolate cake with liquid center.',isVeg:true} ],
  'subway':     [ {name:'Roasted Chicken Sub',price:249,desc:'Chicken breast with fresh veggies.',isVeg:false},{name:'Paneer Tikka Sub',price:229,desc:'Spiced paneer cubes.',isVeg:true},{name:'Tuna Sub',price:279,desc:'Tuna mayo with fresh salad.',isVeg:false},{name:'Veggie Delite',price:199,desc:'All the fresh veggies.',isVeg:true},{name:'Chocolate Chip Cookie',price:49,desc:'Fresh baked soft cookie.',isVeg:true} ],
  'starbucks':  [ {name:'Caffe Latte',price:229,desc:'Espresso with steamed milk.',isVeg:true},{name:'Java Chip Frappuccino',price:319,desc:'Coffee blended with chocolate chips.',isVeg:true},{name:'Caramel Macchiato',price:269,desc:'Vanilla syrup, milk, espresso, caramel.',isVeg:true},{name:'Blueberry Muffin',price:169,desc:'Classic muffin.',isVeg:true},{name:'Butter Croissant',price:149,desc:'Flaky buttery pastry.',isVeg:true} ],
  'pizza hut':  [ {name:'Tandoori Paneer Pizza',price:349,desc:'Paneer tikka, onion, capsicum.',isVeg:true},{name:'Chicken Supreme',price:449,desc:'Lebanese chicken, chicken meatball.',isVeg:false},{name:'Veggie Supreme',price:399,desc:'Black olives, mushroom, capsicum.',isVeg:true},{name:'Cheesy Comfort',price:299,desc:'Cheese burst pizza.',isVeg:true},{name:'Spicy Baked Pasta',price:199,desc:'Pasta in spicy red sauce.',isVeg:true} ],
};

const FALLBACK_RESTAURANTS = [
  { id:'f1', name:'The Gourmet Hub', cuisine:'Continental, Italian', eta:'25-30', rating:'4.8', isVeg:false, image:'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80', location:{lat:28.6139,lng:77.2090}, distance:'1.2', featuredItems:['Pasta Carbonara','Neapolitan Pizza','Tiramisu'] },
  { id:'f2', name:'Spicy Garden',    cuisine:'Indian, Mughlai',      eta:'15-20', rating:'4.5', isVeg:true,  image:'https://images.unsplash.com/photo-1517244681291-03ef738c8d93?w=600&q=80', location:{lat:28.6239,lng:77.2190}, distance:'2.5', featuredItems:['Paneer Tikka','Butter Kulcha','Dal Makhani'] },
  { id:'f3', name:'Burger Lab',      cuisine:'Fast Food, American',  eta:'10-15', rating:'4.2', isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80', location:{lat:28.6039,lng:77.1990}, distance:'0.8', featuredItems:['Mega Crunch Burger','Cheesy Fries','Vanilla Shake'] },
  { id:'f4', name:'Green Bowl Cafe', cuisine:'Salads, Healthy',      eta:'20-25', rating:'4.7', isVeg:true,  image:'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80', location:{lat:28.6339,lng:77.2290}, distance:'3.1', featuredItems:['Quinoa Salad','Avocado Toast','Green Smoothie'] },
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
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (name.trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  try {
    await connectDB();
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name: name.trim(), email, password_hash: hash });
    const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, veg_only: user.veg_only } });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Email already exists' });
    console.error('Register error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    await connectDB();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, veg_only: user.veg_only, address: user.address, phone: user.phone } });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/profile', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id).select('-password_hash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, phone: user.phone, address: user.address, lat: user.lat, lng: user.lng, veg_only: user.veg_only });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/user/profile', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const { phone, address, lat, lng, veg_only } = req.body;
    const updates = {};
    if (phone    !== undefined) updates.phone    = phone;
    if (address  !== undefined) updates.address  = address;
    if (lat      !== undefined) updates.lat      = lat;
    if (lng      !== undefined) updates.lng      = lng;
    if (veg_only !== undefined) updates.veg_only = !!veg_only;
    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password_hash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, address: user.address, lat: user.lat, lng: user.lng, veg_only: user.veg_only } });
  } catch (e) { res.status(500).json({ error: 'Failed to update' }); }
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

app.get('/api/restaurants', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Latitude and Longitude required' });
  const userLat = parseFloat(lat), userLng = parseFloat(lng);
  const query = `[out:json][timeout:15];(node["amenity"="restaurant"](around:8000,${userLat},${userLng});node["amenity"="fast_food"](around:8000,${userLat},${userLng});node["amenity"="cafe"](around:8000,${userLat},${userLng}););out body 40;`;
  try {
    const params = new URLSearchParams(); params.append('data', query);
    const osmRes = await fetch('https://overpass-api.de/api/interpreter', { method:'POST', body:params });
    if (!osmRes.ok) return res.json(FALLBACK_RESTAURANTS);
    const osmData = await osmRes.json();
    if (!osmData.elements?.length) return res.json(FALLBACK_RESTAURANTS);
    const imgs = ['photo-1517248135467-4c7edcad34c4','photo-1552566626-52f8b828add9','photo-1555396273-367ea4eb4db5','photo-1514933651103-005eec06c04b','photo-1414235077428-338989a2e8c0','photo-1502301103665-0b95cc738def','photo-1424847651672-bf2c94a444a6','photo-1551632436-cbf8dd35adfa','photo-1537047902294-62a40c20a6ae','photo-1466978913421-dad2ebd01d17'];
    const restaurants = osmData.elements.map(el => {
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
    res.json(restaurants.length > 0 ? restaurants : FALLBACK_RESTAURANTS);
  } catch { res.json(FALLBACK_RESTAURANTS); }
});

app.get('/api/restaurants/:id/menu', (req, res) => {
  const pId = req.params.id;
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
  res.json((REAL_MENU_DATABASE[cat]||REAL_MENU_DATABASE.snacks).map((item,idx)=>({...item,id:`item_${pId}_${idx}`})));
});

// ORDERS
app.post('/api/orders', verifyTokenOptional, async (req, res) => {
  const { restaurantId, realRestaurantName, restaurantLocation, items, address, phone, lat, lng } = req.body;
  if (!restaurantId || !items?.length) return res.status(400).json({ error: 'restaurantId and items are required' });
  if (!restaurantLocation?.lat || !restaurantLocation?.lng) return res.status(400).json({ error: 'Restaurant location is required' });
  try {
    await connectDB();
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const history = [{ status:'placed', label:'Order Placed', time: new Date() }];
    const order = await Order.create({
      user_id: req.user?.id || null, restaurant_id: restaurantId, real_restaurant_name: realRestaurantName,
      items, status: 'placed', total, address,
      delivery_lat: lat ?? null, delivery_lng: lng ?? null,
      restaurant_lat: restaurantLocation.lat, restaurant_lng: restaurantLocation.lng,
      history, estimated_delivery: new Date(Date.now() + 30 * 60000),
    });
    setTimeout(() => advanceOrder(order._id), 6000);
    res.json({
      orderId: order._id,
      order: { id: order._id, status: 'placed', history, items, total, address, restaurant: { name: realRestaurantName, location: restaurantLocation } },
    });
  } catch (err) { console.error('Order creation error:', err); res.status(500).json({ error: 'Failed to create order' }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    await connectDB();
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({
      id: order._id, status: order.status, history: order.history, driver: order.driver || null,
      estimatedDelivery: order.estimated_delivery,
      restaurant: { name: order.real_restaurant_name, location: { lat: order.restaurant_lat, lng: order.restaurant_lng } },
      total: order.total, address: order.address, items: order.items,
    });
  } catch (err) { console.error('Order fetch error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/orders', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const orders = await Order.find({ user_id: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json(orders.map(o => ({ id: o._id, status: o.status, total: o.total, items: o.items, restaurantName: o.real_restaurant_name, date: o.createdAt })));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
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
    await connectDB();
    const order = await Order.findById(orderId);
    if (order) {
      const payload = {
        type: 'STATUS_UPDATE',
        order: {
          id: order._id, status: order.status, history: order.history,
          driver: order.driver || null, estimatedDelivery: order.estimated_delivery,
          restaurant: { name: order.real_restaurant_name, location: { lat: order.restaurant_lat, lng: order.restaurant_lng } },
          total: order.total, items: order.items, address: order.address,
        },
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', message: 'Order not found' })}\n\n`);
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
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Local dev only — Vercel uses module.exports ──────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`\n⚡ Cravez running at http://localhost:${PORT}\n`));
}

module.exports = app;
