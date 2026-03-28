import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';

if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv');
  dotenv.config();
}

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'quality-laundry-secret-2026';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const ENABLE_ADMIN_TEST_PUSH = process.env.ENABLE_ADMIN_TEST_PUSH === 'true';

const parseFirebaseServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (error) {
    console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
    return null;
  }
};

const firebaseServiceAccount = parseFirebaseServiceAccount();
let firebaseAdminPromise = null;


// ==================== MongoDB ====================
let cachedClient = null;
let cachedDb = null;

const getDB = async () => {
  if (cachedDb) return cachedDb;
  if (!MONGODB_URI) throw new Error('MONGODB_URI required');
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI, { tls: true, tlsAllowInvalidCertificates: false });
    await cachedClient.connect();
    console.log('Connected to MongoDB Atlas');
  }
  cachedDb = cachedClient.db('quality_laundry');
  await seedDefaults(cachedDb);
  return cachedDb;
};

const trimText = (value, maxLength = 4000) => {
  if (!value) return '';
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const normalizeFcmTokens = (value) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((token) => typeof token === 'string' && token.trim()))];
};

const getFirebaseAdmin = async () => {
  if (!firebaseServiceAccount) return null;
  if (!firebaseAdminPromise) {
    firebaseAdminPromise = (async () => {
      const firebaseAdminModule = await import('firebase-admin');
      const admin = firebaseAdminModule.default || firebaseAdminModule;

      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(firebaseServiceAccount),
          databaseURL: FIREBASE_DATABASE_URL || undefined,
        });
      }

      return admin;
    })();
  }

  return firebaseAdminPromise;
};

const getUsersByIds = async (db, userIds) => {
  const uniqueIds = [...new Set(userIds
    .filter(Boolean)
    .map((id) => id.toString()))]
    .map((id) => new ObjectId(id));

  if (!uniqueIds.length) return [];

  return db.collection('users')
    .find({ _id: { $in: uniqueIds }, active: true })
    .project({ _id: 1, name: 1, role: 1, fcmTokens: 1 })
    .toArray();
};

const sendPushNotification = async (db, users, { title, body, data = {} }) => {
  const admin = await getFirebaseAdmin();
  if (!admin) {
    return { success: false, skipped: true, reason: 'Firebase Admin belum dikonfigurasi di backend' };
  }

  const recipients = users
    .map((user) => ({ ...user, fcmTokens: normalizeFcmTokens(user.fcmTokens) }))
    .filter((user) => user.fcmTokens.length > 0);

  if (!recipients.length) {
    return { success: false, skipped: true, reason: 'Tidak ada token FCM aktif untuk penerima' };
  }

  const tokenOwners = recipients.flatMap((user) => user.fcmTokens.map((token) => ({
    userId: user._id.toString(),
    token,
  })));

  const response = await admin.messaging().sendEachForMulticast({
    tokens: tokenOwners.map((entry) => entry.token),
    data: Object.fromEntries(
      Object.entries({ title, body, ...data })
        .filter(([, value]) => value != null && String(value).trim() !== '')
        .map(([key, value]) => [key, String(value)])
    ),
    android: { priority: 'high' },
  });

  const invalidTokensByUser = new Map();
  response.responses.forEach((item, index) => {
    if (item.success) return;

    const code = item.error?.code;
    if (!['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) {
      return;
    }

    const owner = tokenOwners[index];
    const tokens = invalidTokensByUser.get(owner.userId) || [];
    tokens.push(owner.token);
    invalidTokensByUser.set(owner.userId, tokens);
  });

  await Promise.all([...invalidTokensByUser.entries()].map(([userId, invalidTokens]) => (
    db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $pull: { fcmTokens: { $in: invalidTokens } } }
    )
  )));

  return {
    success: true,
    sent: response.successCount,
    failed: response.failureCount,
  };
};

const ensureOrderAccess = (order, user) => {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return String(order.customerId) === String(user._id);
  if (user.role === 'courier') return order.courierId && String(order.courierId) === String(user._id);
  return false;
};

const orderStatusLabel = (status) => ({
  pending: 'Menunggu Jemput',
  pickup: 'Sedang Dijemput',
  washing: 'Sedang Diproses',
  done: 'Siap Diantar',
  delivery: 'Sedang Diantar',
  delivered: 'Selesai',
  cancelled: 'Dibatalkan',
}[status] || status);

const buildOrderStatusNotification = (order, status, note = '') => {
  const label = orderStatusLabel(status);
  const suffix = note ? ` (${trimText(note, 80)})` : '';

  return {
    title: `Update Pesanan ${order.orderNumber}`,
    body: `Status pesanan berubah menjadi ${label}${suffix}`,
    data: {
      type: 'order_status',
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      status,
    },
  };
};

const isFirebaseConfigured = () => Boolean(firebaseServiceAccount);

const seedDefaults = async (db) => {
  const serviceCount = await db.collection('services').countDocuments();
  if (serviceCount === 0) {
    await db.collection('services').insertMany([
      { name: 'Cuci Setrika', pricePerKg: 7000, description: 'Cuci bersih + setrika rapi', estimasiHari: 2, active: true },
      { name: 'Cuci Kering', pricePerKg: 6000, description: 'Cuci kering tanpa setrika', estimasiHari: 2, active: true },
      { name: 'Setrika Saja', pricePerKg: 5000, description: 'Setrika saja', estimasiHari: 1, active: true },
      { name: 'Cuci Express', pricePerKg: 12000, description: 'Selesai dalam 6 jam', estimasiHari: 0, active: true },
      { name: 'Cuci Bed Cover', pricePerUnit: 25000, description: 'Bed cover / selimut tebal', estimasiHari: 3, active: true },
      { name: 'Cuci Jas', pricePerUnit: 20000, description: 'Dry clean jas', estimasiHari: 3, active: true },
    ]);
    console.log('Default services seeded');
  }

  const settingsCount = await db.collection('settings').countDocuments();
  if (settingsCount === 0) {
    await db.collection('settings').insertOne({
      _key: 'store',
      namaLaundry: 'Quality Laundry',
      alamat: '',
      telepon: '',
      qrisImage: '',
      bankTransfer: { bank: 'BCA', noRekening: '', atasNama: '' },
    });
    console.log('Default settings seeded');
  }

  // Seed admin user
  const adminCount = await db.collection('users').countDocuments({ role: 'admin' });
  if (adminCount === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.collection('users').insertOne({
      name: 'Admin',
      phone: '08123456789',
      email: 'admin@qualitylaundry.com',
      password: hash,
      role: 'admin',
      active: true,
      createdAt: new Date(),
    });
    console.log('Default admin seeded');
  }

  // Seed courier user
  const courierCount = await db.collection('users').countDocuments({ role: 'courier' });
  if (courierCount === 0) {
    const hash = await bcrypt.hash('kurir123', 10);
    await db.collection('users').insertOne({
      name: 'Kurir Test',
      phone: '08111111111',
      email: 'kurir@qualitylaundry.com',
      password: hash,
      role: 'courier',
      active: true,
      createdAt: new Date(),
    });
    console.log('Default courier seeded');
  }

  // Seed customer user
  const customerCount = await db.collection('users').countDocuments({ role: 'customer' });
  if (customerCount === 0) {
    const hash = await bcrypt.hash('pelanggan123', 10);
    await db.collection('users').insertOne({
      name: 'Pelanggan Test',
      phone: '08222222222',
      email: 'pelanggan@qualitylaundry.com',
      password: hash,
      role: 'customer',
      active: true,
      createdAt: new Date(),
    });
    console.log('Default customer seeded');
  }
};

// ==================== Express ====================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/client-errors', async (req, res) => {
  try {
    const {
      source,
      severity,
      message,
      stackTrace,
      screen,
      action,
      appVersion,
      buildType,
      deviceModel,
      osVersion,
      threadName,
      isFatal,
      occurredAt,
    } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: 'Message wajib diisi' });
    }

    const db = await getDB();
    await db.collection('app_error_logs').insertOne({
      source: trimText(source || 'android', 50),
      severity: trimText(severity || 'error', 20),
      message: trimText(message, 2000),
      stackTrace: trimText(stackTrace, 20000),
      screen: trimText(screen, 200),
      action: trimText(action, 200),
      appVersion: trimText(appVersion, 50),
      buildType: trimText(buildType, 50),
      deviceModel: trimText(deviceModel, 200),
      osVersion: trimText(osVersion, 100),
      threadName: trimText(threadName, 100),
      isFatal: Boolean(isFatal),
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      ipAddress: req.ip,
      userAgent: trimText(req.get('user-agent'), 500),
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Auth Middleware ====================
const auth = (roles = []) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Token diperlukan' });
      const decoded = jwt.verify(token, JWT_SECRET);
      const db = await getDB();
      const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
      if (!user || !user.active) return res.status(401).json({ error: 'User tidak ditemukan' });
      if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Akses ditolak' });
      req.user = user;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Token tidak valid' });
    }
  };
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Nama, telepon, dan password wajib diisi' });
    const db = await getDB();
    const existing = await db.collection('users').findOne({ phone });
    if (existing) return res.status(400).json({ error: 'Nomor telepon sudah terdaftar' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.collection('users').insertOne({
      name, phone, email: email || '', password: hash,
      role: 'customer', active: true, createdAt: new Date(),
      address: '', lat: null, lng: null,
    });
    const token = jwt.sign({ userId: result.insertedId.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.insertedId, name, phone, role: 'customer' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Telepon dan password wajib' });
    const db = await getDB();
    const user = await db.collection('users').findOne({ phone });
    if (!user) return res.status(400).json({ error: 'User tidak ditemukan' });
    if (!user.active) return res.status(400).json({ error: 'Akun dinonaktifkan' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Password salah' });
    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, phone: user.phone, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth(), async (req, res) => {
  const { password, ...user } = req.user;
  res.json({ user: { ...user, id: user._id } });
});

app.post('/api/users/me/fcm-token', auth(), async (req, res) => {
  try {
    const token = trimText(req.body?.token, 4096).trim();
    if (!token) return res.status(400).json({ error: 'Token FCM wajib diisi' });

    const db = await getDB();
    await db.collection('users').updateMany(
      { _id: { $ne: req.user._id }, fcmTokens: token },
      { $pull: { fcmTokens: token } }
    );

    await db.collection('users').updateOne(
      { _id: req.user._id },
      {
        $addToSet: { fcmTokens: token },
        $set: { lastFcmTokenAt: new Date(), updatedAt: new Date() },
      }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/me/fcm-token', auth(), async (req, res) => {
  try {
    const token = trimText(req.body?.token, 4096).trim();
    if (!token) return res.status(400).json({ error: 'Token FCM wajib diisi' });

    const db = await getDB();
    await db.collection('users').updateOne(
      { _id: req.user._id },
      {
        $pull: { fcmTokens: token },
        $set: { updatedAt: new Date() },
      }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat/notify', auth(), async (req, res) => {
  try {
    const { orderId, message } = req.body || {};
    if (!orderId || !ObjectId.isValid(orderId)) {
      return res.status(400).json({ error: 'Order ID tidak valid' });
    }

    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    if (!ensureOrderAccess(order, req.user)) return res.status(403).json({ error: 'Akses ditolak' });

    const adminUsers = await db.collection('users')
      .find({ role: 'admin', active: true })
      .project({ _id: 1, name: 1, role: 1, fcmTokens: 1 })
      .toArray();
    const participantUsers = await getUsersByIds(db, [order.customerId, order.courierId]);
    const recipients = [...adminUsers, ...participantUsers]
      .filter((user) => String(user._id) !== String(req.user._id));

    const result = await sendPushNotification(db, recipients, {
      title: `Pesan baru ${order.orderNumber}`,
      body: `${req.user.name}: ${trimText(message, 120)}`,
      data: {
        type: 'chat_message',
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        senderRole: req.user.role,
      },
    });

    res.json({ success: true, notification: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== SERVICES ROUTES ====================
app.get('/api/services', async (req, res) => {
  try {
    const db = await getDB();
    const services = await db.collection('services').find({ active: true }).toArray();
    res.json(services);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const result = await db.collection('services').insertOne({ ...req.body, active: true });
    res.json({ id: result.insertedId, ...req.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/services/:id', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    await db.collection('services').updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/services/:id', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    await db.collection('services').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active: false } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ORDERS ROUTES ====================
app.post('/api/orders', auth(['customer']), async (req, res) => {
  try {
    const { services, pickupAddress, pickupLat, pickupLng, pickupNote, paymentMethod } = req.body;
    if (!services || !services.length) return res.status(400).json({ error: 'Pilih minimal 1 layanan' });
    if (!pickupAddress) return res.status(400).json({ error: 'Alamat penjemputan wajib' });

    const db = await getDB();
    const orderNumber = 'QL-' + Date.now().toString(36).toUpperCase();

    const order = {
      orderNumber,
      customerId: req.user._id,
      customerName: req.user.name,
      customerPhone: req.user.phone,
      services, // [{ serviceId, serviceName, price, unit }]
      totalPrice: 0, // Will be calculated when admin inputs weight
      weight: null,
      pickupAddress,
      pickupLat: pickupLat || null,
      pickupLng: pickupLng || null,
      pickupNote: pickupNote || '',
      paymentMethod: paymentMethod || 'belum ditentukan',
      paymentStatus: 'unpaid',
      status: 'pending',
      courierId: null,
      courierName: null,
      statusHistory: [{ status: 'pending', time: new Date(), note: 'Pesanan dibuat, menunggu kurir' }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('orders').insertOne(order);
    order._id = result.insertedId;

    const staffUsers = await db.collection('users')
      .find({ role: { $in: ['admin', 'courier'] }, active: true })
      .project({ _id: 1, name: 1, role: 1, fcmTokens: 1 })
      .toArray();

    await sendPushNotification(db, staffUsers, {
      title: 'Pesanan laundry baru',
      body: `${order.customerName} membuat pesanan ${order.orderNumber}`,
      data: {
        type: 'order_created',
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
      },
    });

    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get orders (role-based)
app.get('/api/orders', auth(), async (req, res) => {
  try {
    const db = await getDB();
    let filter = {};
    if (req.user.role === 'customer') {
      filter.customerId = req.user._id;
    } else if (req.user.role === 'courier') {
      filter.$or = [
        { courierId: req.user._id },
        { status: 'pending', courierId: null },
      ];
    }
    // admin sees all

    const { status, page = 1, limit = 20 } = req.query;
    if (status) filter.status = status;

    const orders = await db.collection('orders')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection('orders').countDocuments(filter);
    res.json({ orders, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id', auth(), async (req, res) => {
  try {
    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    // Customer can only see own orders
    if (req.user.role === 'customer' && order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update order status
app.put('/api/orders/:id/status', auth(['admin', 'courier']), async (req, res) => {
  try {
    const { status, note, weight } = req.body;
    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });

    const courierCancelReasons = [
      'Jarak terlalu jauh',
      'Alamat tidak ditemukan',
      'Customer tidak merespons',
    ];

    const allowedTransitions = {
      admin: {
        washing: ['done'],
      },
      courier: {
        pending: ['pickup', 'cancelled'],
        pickup: ['washing', 'cancelled'],
        done: ['delivery'],
        delivery: ['delivered'],
      },
    };
    const roleTransitions = allowedTransitions[req.user.role] || {};
    const nextStatuses = roleTransitions[order.status] || [];
    if (!nextStatuses.includes(status)) {
      return res.status(400).json({ error: 'Transisi status tidak diizinkan untuk role ini' });
    }

    if (req.user.role === 'courier' && status === 'cancelled' && !courierCancelReasons.includes(note)) {
      return res.status(400).json({ error: 'Alasan pembatalan kurir tidak valid' });
    }

    if (req.user.role === 'courier' && order.courierId && status !== 'pickup') {
      if (String(order.courierId) !== String(req.user._id)) {
        return res.status(403).json({ error: 'Pesanan ini ditangani kurir lain' });
      }
    }

    const update = {
      status,
      updatedAt: new Date(),
      $push: { statusHistory: { status, time: new Date(), note: note || '', by: req.user.name } },
    };

    // If courier takes the order
    if (status === 'pickup' && req.user.role === 'courier') {
      update.courierId = req.user._id;
      update.courierName = req.user.name;
    }

    // Admin inputs weight → calculate total price
    if (weight && parseFloat(weight) > 0) {
      update.weight = parseFloat(weight);
      let newTotal = 0;
      for (const s of order.services) {
        newTotal += s.price * parseFloat(weight);
      }
      update.totalPrice = Math.round(newTotal);
    }

    if (status === 'delivered') {
      update.paymentStatus = 'paid';
    }

    const { $push, ...setFields } = update;
    await db.collection('orders').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: setFields, $push }
    );

    const notificationRecipients = [order.customerId];
    if (status === 'done' && order.courierId) {
      notificationRecipients.push(order.courierId);
    }

    const recipientUsers = await getUsersByIds(db, notificationRecipients);
    await sendPushNotification(
      db,
      recipientUsers,
      buildOrderStatusNotification(order, status, note)
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update order weight (admin only)
app.put('/api/orders/:id/weight', auth(['admin']), async (req, res) => {
  try {
    const { weight } = req.body;
    if (!weight || parseFloat(weight) <= 0) return res.status(400).json({ error: 'Berat harus lebih dari 0' });

    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });

    const w = parseFloat(weight);
    let newTotal = 0;
    for (const s of order.services) {
      newTotal += s.price * w;
    }

    await db.collection('orders').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { weight: w, totalPrice: Math.round(newTotal), updatedAt: new Date() } }
    );

    res.json({ success: true, weight: w, totalPrice: Math.round(newTotal) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update order payment method (admin only)
app.put('/api/orders/:id/payment', auth(['admin']), async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    if (!paymentMethod) return res.status(400).json({ error: 'Metode pembayaran wajib diisi' });
    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    await db.collection('orders').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { paymentMethod, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== USERS (ADMIN) ====================

// Update order pickup location (courier corrects customer coordinates)
app.put('/api/orders/:id/location', auth(['courier']), async (req, res) => {
  try {
    const { pickupLat, pickupLng } = req.body;
    if (pickupLat == null || pickupLng == null) return res.status(400).json({ error: 'Koordinat wajib diisi' });
    const db = await getDB();
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    await db.collection('orders').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { pickupLat: parseFloat(pickupLat), pickupLng: parseFloat(pickupLng), updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const { role } = req.query;
    const filter = role ? { role } : {};
    const users = await db.collection('users').find(filter).project({ password: 0 }).toArray();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/courier', auth(['admin']), async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Data kurir wajib lengkap' });
    const db = await getDB();
    const existing = await db.collection('users').findOne({ phone });
    if (existing) return res.status(400).json({ error: 'Nomor telepon sudah terdaftar' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.collection('users').insertOne({
      name, phone, email: '', password: hash,
      role: 'courier', active: true, createdAt: new Date(),
    });
    res.json({ id: result.insertedId, name, phone, role: 'courier' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id/toggle', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    await db.collection('users').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active: !user.active } });
    res.json({ success: true, active: !user.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', auth(['admin']), async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Nama dan nomor telepon wajib diisi' });

    const db = await getDB();
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    if (!['customer', 'courier'].includes(user.role)) return res.status(400).json({ error: 'Menu ini hanya untuk data pelanggan dan kurir' });

    const phoneOwner = await db.collection('users').findOne({ phone, _id: { $ne: new ObjectId(req.params.id) } });
    if (phoneOwner) return res.status(400).json({ error: 'Nomor telepon sudah dipakai user lain' });

    const updateData = {
      name,
      phone,
      email: email || '',
      updatedAt: new Date(),
    };
    if (password && password.trim()) {
      updateData.password = await bcrypt.hash(password.trim(), 10);
    }

    await db.collection('users').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    if (user.role !== 'customer') return res.status(400).json({ error: 'Menu ini hanya untuk data pelanggan' });

    await db.collection('users').deleteOne({ _id: new ObjectId(req.params.id) });
    await db.collection('orders').deleteMany({ customerId: user._id });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== SETTINGS ====================
app.get('/api/settings', async (req, res) => {
  try {
    const db = await getDB();
    const settings = await db.collection('settings').findOne({ _key: 'store' });
    res.json(settings || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const { _id, _key, ...data } = req.body;
    await db.collection('settings').updateOne({ _key: 'store' }, { $set: data }, { upsert: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== DASHBOARD (ADMIN) ====================
app.get('/api/dashboard', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [totalOrders, todayOrders, pendingOrders, totalRevenue, totalCustomers] = await Promise.all([
      db.collection('orders').countDocuments(),
      db.collection('orders').countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      db.collection('orders').countDocuments({ status: { $nin: ['delivered', 'cancelled'] } }),
      db.collection('orders').aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } }
      ]).toArray(),
      db.collection('users').countDocuments({ role: 'customer' }),
    ]);

    res.json({
      totalOrders,
      todayOrders,
      pendingOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalCustomers,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/notification-health', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const users = await db.collection('users')
      .find({ active: true })
      .project({ role: 1, fcmTokens: 1 })
      .toArray();

    const summary = {
      admin: { users: 0, withTokens: 0, tokens: 0 },
      courier: { users: 0, withTokens: 0, tokens: 0 },
      customer: { users: 0, withTokens: 0, tokens: 0 },
    };

    users.forEach((user) => {
      const role = ['admin', 'courier', 'customer'].includes(user.role) ? user.role : 'customer';
      const tokens = normalizeFcmTokens(user.fcmTokens);
      summary[role].users += 1;
      summary[role].tokens += tokens.length;
      if (tokens.length > 0) {
        summary[role].withTokens += 1;
      }
    });

    res.json({
      firebaseConfigured: isFirebaseConfigured(),
      firebaseDatabaseUrlConfigured: Boolean(FIREBASE_DATABASE_URL),
      adminTestPushEnabled: ENABLE_ADMIN_TEST_PUSH,
      summary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/test-notification', auth(['admin']), async (req, res) => {
  try {
    if (!ENABLE_ADMIN_TEST_PUSH) {
      return res.status(403).json({ error: 'Test notification dinonaktifkan di environment ini' });
    }

    const { userId, title, body } = req.body || {};
    const targetUserId = userId || req.user._id.toString();
    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'User ID tidak valid' });
    }

    const messageTitle = trimText(title || 'Tes notifikasi Quality Laundry', 120);
    const messageBody = trimText(body || 'Push notification backend berhasil dikirim.', 240);

    const db = await getDB();
    const recipients = await getUsersByIds(db, [targetUserId]);
    if (!recipients.length) {
      return res.status(404).json({ error: 'User target tidak ditemukan atau tidak aktif' });
    }

    const result = await sendPushNotification(db, recipients, {
      title: messageTitle,
      body: messageBody,
      data: {
        type: 'admin_test',
        targetUserId,
      },
    });

    res.json({ success: true, notification: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== HEALTH ====================
app.get('/api/health', async (req, res) => {
  try {
    const db = await getDB();
    res.json({
      status: 'ok',
      db: 'connected',
      notifications: {
        firebaseConfigured: isFirebaseConfigured(),
        firebaseDatabaseUrlConfigured: Boolean(FIREBASE_DATABASE_URL),
        adminTestPushEnabled: ENABLE_ADMIN_TEST_PUSH,
      },
    });
  } catch (e) {
    res.json({
      status: 'ok',
      db: 'error',
      notifications: {
        firebaseConfigured: isFirebaseConfigured(),
        firebaseDatabaseUrlConfigured: Boolean(FIREBASE_DATABASE_URL),
        adminTestPushEnabled: ENABLE_ADMIN_TEST_PUSH,
      },
    });
  }
});

// ==================== CHAT CLEANUP (90 days) ====================
app.delete('/api/admin/chat-cleanup', auth(['admin']), async (req, res) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    res.json({
      message: 'Chat cleanup policy: messages older than 90 days',
      cutoffDate: cutoffDate.toISOString(),
      note: 'Firebase Realtime DB chat data should be cleaned via Firebase Admin SDK or scheduled Cloud Function'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== REPORTS (ADMIN) ====================
app.get('/api/admin/reports', auth(['admin']), async (req, res) => {
  try {
    const { period = 'daily', date } = req.query; // period: daily, weekly, monthly
    const db = await getDB();

    let startDate, endDate;
    const baseDate = date ? new Date(date) : new Date();
    baseDate.setHours(0, 0, 0, 0);

    if (period === 'daily') {
      startDate = new Date(baseDate);
      endDate = new Date(baseDate);
      endDate.setDate(endDate.getDate() + 1);
    } else if (period === 'weekly') {
      startDate = new Date(baseDate);
      startDate.setDate(startDate.getDate() - startDate.getDay()); // Start of week (Sunday)
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7);
    } else { // monthly
      startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
      endDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1);
    }

    const filter = { createdAt: { $gte: startDate, $lt: endDate } };

    const orders = await db.collection('orders').find(filter).sort({ createdAt: -1 }).toArray();

    const totalOrders = orders.length;
    const completedOrders = orders.filter(o => o.status === 'delivered').length;
    const cancelledOrders = orders.filter(o => o.status === 'cancelled').length;
    const pendingOrders = orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length;
    const totalRevenue = orders.filter(o => o.paymentStatus === 'paid').reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalWeight = orders.reduce((sum, o) => sum + (o.weight || 0), 0);

    // Breakdown per service
    const serviceBreakdown = {};
    orders.forEach(o => {
      o.services?.forEach(s => {
        if (!serviceBreakdown[s.serviceName]) {
          serviceBreakdown[s.serviceName] = { count: 0, revenue: 0 };
        }
        serviceBreakdown[s.serviceName].count++;
        if (o.paymentStatus === 'paid' && o.weight) {
          serviceBreakdown[s.serviceName].revenue += s.price * o.weight;
        }
      });
    });

    // DB stats (estimate)
    const totalOrdersAll = await db.collection('orders').countDocuments();
    const totalUsersAll = await db.collection('users').countDocuments();
    const oldestOrder = await db.collection('orders').findOne({}, { sort: { createdAt: 1 } });
    const dataAgeMonths = oldestOrder ? Math.floor((Date.now() - new Date(oldestOrder.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000)) : 0;
    // Rough estimate: each order ~2KB, each user ~1KB
    const estimatedStorageMB = ((totalOrdersAll * 2) + (totalUsersAll * 1)) / 1024;

    res.json({
      period,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalOrders,
      completedOrders,
      cancelledOrders,
      pendingOrders,
      totalRevenue,
      totalWeight: Math.round(totalWeight * 100) / 100,
      serviceBreakdown,
      orders: orders.map(o => ({
        _id: o._id,
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        services: o.services,
        weight: o.weight,
        totalPrice: o.totalPrice,
        status: o.status,
        paymentStatus: o.paymentStatus,
        createdAt: o.createdAt,
      })),
      dbStats: {
        totalOrdersAll,
        totalUsersAll,
        dataAgeMonths,
        estimatedStorageMB: Math.round(estimatedStorageMB * 100) / 100,
        maxStorageMB: 512, // MongoDB Atlas free tier
        warningThreshold: dataAgeMonths >= 2, // Warn if data is 2+ months old
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download XLSX report
app.get('/api/admin/reports/download', async (req, res) => {
  try {
    // Support token via query param for browser download
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token diperlukan' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDB();
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { period = 'daily', date } = req.query;

    let startDate, endDate, periodLabel;
    const baseDate = date ? new Date(date) : new Date();
    baseDate.setHours(0, 0, 0, 0);

    if (period === 'daily') {
      startDate = new Date(baseDate);
      endDate = new Date(baseDate);
      endDate.setDate(endDate.getDate() + 1);
      periodLabel = startDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
    } else if (period === 'weekly') {
      startDate = new Date(baseDate);
      startDate.setDate(startDate.getDate() - startDate.getDay());
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7);
      periodLabel = `${startDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })} - ${new Date(endDate.getTime() - 86400000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    } else {
      startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
      endDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1);
      periodLabel = startDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }

    const orders = await db.collection('orders')
      .find({ createdAt: { $gte: startDate, $lt: endDate } })
      .sort({ createdAt: -1 }).toArray();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Quality Laundry';
    workbook.created = new Date();

    // Sheet 1: Ringkasan
    const summarySheet = workbook.addWorksheet('Ringkasan');
    summarySheet.columns = [
      { header: 'Keterangan', key: 'label', width: 30 },
      { header: 'Nilai', key: 'value', width: 25 },
    ];
    summarySheet.getRow(1).font = { bold: true };

    const totalRevenue = orders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + (o.totalPrice || 0), 0);
    const totalWeight = orders.reduce((s, o) => s + (o.weight || 0), 0);

    summarySheet.addRows([
      { label: 'Periode', value: periodLabel },
      { label: 'Total Pesanan', value: orders.length },
      { label: 'Pesanan Selesai', value: orders.filter(o => o.status === 'delivered').length },
      { label: 'Pesanan Dibatalkan', value: orders.filter(o => o.status === 'cancelled').length },
      { label: 'Pesanan Dalam Proses', value: orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length },
      { label: 'Total Berat (kg)', value: Math.round(totalWeight * 100) / 100 },
      { label: 'Total Pendapatan (Rp)', value: totalRevenue },
    ]);

    // Sheet 2: Detail Pesanan
    const detailSheet = workbook.addWorksheet('Detail Pesanan');
    detailSheet.columns = [
      { header: 'No', key: 'no', width: 5 },
      { header: 'No. Pesanan', key: 'orderNumber', width: 18 },
      { header: 'Pelanggan', key: 'customer', width: 20 },
      { header: 'Telepon', key: 'phone', width: 15 },
      { header: 'Layanan', key: 'services', width: 30 },
      { header: 'Berat (kg)', key: 'weight', width: 12 },
      { header: 'Total (Rp)', key: 'total', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Pembayaran', key: 'payment', width: 12 },
      { header: 'Tanggal', key: 'date', width: 20 },
    ];
    detailSheet.getRow(1).font = { bold: true };

    orders.forEach((o, i) => {
      detailSheet.addRow({
        no: i + 1,
        orderNumber: o.orderNumber,
        customer: o.customerName,
        phone: o.customerPhone,
        services: (o.services || []).map(s => s.serviceName).join(', '),
        weight: o.weight || 0,
        total: o.totalPrice || 0,
        status: o.status,
        payment: o.paymentStatus,
        date: new Date(o.createdAt).toLocaleString('id-ID'),
      });
    });

    // Sheet 3: Per Layanan
    const serviceSheet = workbook.addWorksheet('Per Layanan');
    serviceSheet.columns = [
      { header: 'Layanan', key: 'name', width: 25 },
      { header: 'Jumlah Order', key: 'count', width: 15 },
      { header: 'Pendapatan (Rp)', key: 'revenue', width: 20 },
    ];
    serviceSheet.getRow(1).font = { bold: true };

    const svcMap = {};
    orders.forEach(o => {
      o.services?.forEach(s => {
        if (!svcMap[s.serviceName]) svcMap[s.serviceName] = { count: 0, revenue: 0 };
        svcMap[s.serviceName].count++;
        if (o.paymentStatus === 'paid' && o.weight) svcMap[s.serviceName].revenue += s.price * o.weight;
      });
    });
    Object.entries(svcMap).forEach(([name, data]) => {
      serviceSheet.addRow({ name, count: data.count, revenue: Math.round(data.revenue) });
    });

    const filename = `Laporan_QualityLaundry_${period}_${baseDate.toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete old orders (cleanup)
app.delete('/api/admin/reports/cleanup', auth(['admin']), async (req, res) => {
  try {
    const { beforeDate } = req.body; // ISO date string
    if (!beforeDate) return res.status(400).json({ error: 'beforeDate wajib diisi (ISO format)' });

    const cutoff = new Date(beforeDate);
    if (isNaN(cutoff.getTime())) return res.status(400).json({ error: 'Format tanggal tidak valid' });

    const db = await getDB();

    // Only delete completed or cancelled orders older than cutoff
    const filter = {
      createdAt: { $lt: cutoff },
      status: { $in: ['delivered', 'cancelled'] }
    };

    const countToDelete = await db.collection('orders').countDocuments(filter);
    const result = await db.collection('orders').deleteMany(filter);

    res.json({
      success: true,
      deletedCount: result.deletedCount,
      message: `${result.deletedCount} pesanan (selesai/batal) sebelum ${cutoff.toLocaleDateString('id-ID')} telah dihapus`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DB storage stats
app.get('/api/admin/db-stats', auth(['admin']), async (req, res) => {
  try {
    const db = await getDB();
    const stats = await db.command({ dbStats: 1 });
    const totalOrdersAll = await db.collection('orders').countDocuments();
    const oldestOrder = await db.collection('orders').findOne({}, { sort: { createdAt: 1 } });
    const dataAgeMonths = oldestOrder ? Math.floor((Date.now() - new Date(oldestOrder.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000)) : 0;

    res.json({
      storageSizeMB: Math.round((stats.storageSize || 0) / (1024 * 1024) * 100) / 100,
      dataSizeMB: Math.round((stats.dataSize || 0) / (1024 * 1024) * 100) / 100,
      totalDocuments: totalOrdersAll,
      dataAgeMonths,
      maxStorageMB: 512,
      usagePercent: Math.round(((stats.storageSize || 0) / (512 * 1024 * 1024)) * 10000) / 100,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`Quality Laundry API running on port ${PORT}`));

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sedang dipakai proses lain. Hentikan proses itu atau jalankan server dengan PORT berbeda.`);
    process.exit(1);
  }

  console.error('Gagal menjalankan server:', error);
  process.exit(1);
});

export default app;
