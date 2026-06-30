# Sarvam AI WebSocket Proxy

This tiny server solves one problem: **browsers cannot send custom HTTP headers
when opening a WebSocket connection**, but Sarvam AI's streaming speech-to-text
API requires an `Api-Subscription-Key` header for authentication.

This proxy sits in the middle:

```
Browser  --WebSocket-->  This Proxy  --WebSocket + Auth Header-->  Sarvam AI
```

The browser connects to *this* server with no special headers needed. This
server then opens its own connection to Sarvam (where it CAN send the header,
since it's a Node.js script, not a browser) and relays audio/transcripts
both ways in real time.

## Deploy for free on Render.com

1. Go to https://render.com and sign up (free, no credit card needed for this tier)
2. Click **New +** → **Web Service**
3. Choose **Build and deploy from a Git repository** OR **Public Git repository**
   - If you don't have a repo for this yet, you can also choose **Deploy an existing image** is NOT needed — just push this folder to a new GitHub repo first (see below), then connect it.
4. Settings:
   - **Name**: `sarvam-proxy` (or anything)
   - **Region**: closest to India (Singapore recommended)
   - **Branch**: main
   - **Root Directory**: leave blank (or point to this folder if it's in a subfolder)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Add Environment Variable:
   - **Key**: `SARVAM_API_KEY`
   - **Value**: your Sarvam API key (the one starting with `sk_...`)
6. Click **Create Web Service**
7. Wait ~2 minutes for it to deploy. You'll get a URL like:
   `https://sarvam-proxy-xxxx.onrender.com`

## Deploy for free on Railway.app (alternative)

1. Go to https://railway.app and sign up
2. **New Project** → **Deploy from GitHub repo** (push this folder to GitHub first)
3. Add environment variable `SARVAM_API_KEY` in the Railway dashboard
4. Railway auto-detects Node.js and deploys
5. Generate a public domain under **Settings** → **Networking** → **Generate Domain**

## Pushing this folder to GitHub (needed for either platform)

```bash
cd sarvam-proxy
git init
git add .
git commit -m "Sarvam proxy server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sarvam-proxy.git
git push -u origin main
```

## After deployment

Once deployed, you'll have a URL like `https://sarvam-proxy-xxxx.onrender.com`.

Your WebSocket endpoint will be:
```
wss://sarvam-proxy-xxxx.onrender.com/stt?language_code=hi-IN&model=saarika:v2.5
```

Give this URL to update the main Vishal Navigation app — replace the direct
Sarvam WebSocket URL with this proxy URL instead.

## Testing the health check

Visit `https://sarvam-proxy-xxxx.onrender.com/health` in your browser.
You should see:
```json
{"status":"ok","service":"sarvam-proxy","hasKey":true}
```

If `hasKey` is `false`, the environment variable wasn't set correctly.

## Note on Render free tier

Render's free tier spins down after 15 minutes of inactivity and takes
~30-60 seconds to wake up on the next request. For a BPO call center in
active daily use, this is usually fine since the first call of the day
will have a brief delay, then it stays warm. If this causes problems,
Railway's free tier or a $7/month Render plan keeps it always-on.
