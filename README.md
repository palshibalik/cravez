# Cravez Food Tracker

Cravez is a food delivery and order tracking web app built with vanilla HTML, CSS, JavaScript, Express, and MongoDB. It includes customer browsing, restaurant menus, login/signup, seller menu management, rider/support dashboards, order placement, and real-time order tracking through server-sent events.

## Features

- Customer login and signup
- Fallback login mode so users can still enter the app if auth or MongoDB is unavailable
- Restaurant discovery with local fallback data
- Restaurant menu loading with server and client fallback menus
- Cart, checkout, and order tracking
- Seller dashboard for menu/profile management
- Rider and support dashboard routes
- Image upload support
- Vercel-compatible Express deployment

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js, Express
- Database: MongoDB with Mongoose
- Auth: JSON Web Tokens and bcryptjs
- Deployment: Vercel

## Project Structure

```text
.
├── index.html
├── style.css
├── script.js
├── server.js
├── package.json
├── vercel.json
├── env.example
└── uploads/
```

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp env.example .env
```

Update `.env` with your MongoDB and JWT values:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.mongodb.net/cravez?retryWrites=true&w=majority
JWT_SECRET=replace_with_a_long_random_secret
PORT=3000
CLIENT_ORIGIN=*
AUTH_FALLBACK_ENABLED=true
NODE_ENV=development
```

Run the app:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Build Check

Run the syntax/build check before deploying:

```bash
npm run build
```

## Vercel Deployment

This project includes a `vercel.json` file for Vercel deployment.

In Vercel Project Settings, add these environment variables:

```env
MONGODB_URI=your_mongodb_atlas_connection_string
JWT_SECRET=your_long_random_secret
CLIENT_ORIGIN=https://your-project.vercel.app
AUTH_FALLBACK_ENABLED=true
NODE_ENV=production
```

Important MongoDB Atlas note:

- Add Vercel-compatible network access in MongoDB Atlas.
- For simple testing, allow `0.0.0.0/0`.
- For production, restrict access as appropriate for your setup.

## Auth and Menu Fallbacks

The app is designed to keep loading even if MongoDB or auth temporarily fails.

- If MongoDB is unavailable, login/signup creates a non-persistent fallback session.
- If the auth API cannot be reached, the frontend creates a local fallback session.
- If the menu API fails, the frontend displays a local fallback menu.
- If seller menu APIs fail in fallback mode, they return safe responses instead of blocking the UI.

To disable fallback auth in stricter production environments:

```env
AUTH_FALLBACK_ENABLED=false
```

## Useful Scripts

```bash
npm start
npm run dev
npm run build
```

## Notes

- Uploaded files are stored in `uploads/` locally.
- On Vercel production, uploads use `/tmp/uploads`, which is temporary serverless storage.
- For production-ready persistent uploads, connect an external storage provider such as Cloudinary, S3, or Vercel Blob.

