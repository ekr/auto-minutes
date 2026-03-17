# Google Cloud Speech-to-Text Setup

## 1. Create a GCP Project (if you don't have one)

- Go to https://console.cloud.google.com
- Create a new project or select an existing one

## 2. Enable the Speech-to-Text API

- Go to **APIs & Services > Library**
- Search for **"Cloud Speech-to-Text API"** and click **Enable**

## 3. Create a Service Account & Key

- Go to **IAM & Admin > Service Accounts**
- Click **Create Service Account**
- Name it something like `auto-minutes-stt`
- Grant these roles:
  - **Cloud Speech Client** (for Speech-to-Text)
  - **Storage Object Admin** (for uploading/downloading audio to GCS)
- Click **Done**, then click the service account, go to **Keys** tab
- **Add Key > Create new key > JSON**
- Save the downloaded file as `gcp-key.json` in the project root

## 4. Create a GCS Bucket

The code uploads audio files to a GCS bucket for batch recognition. Create one:

```bash
# Install gcloud CLI if needed: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Create a bucket (use US region since chirp_3 requires the "us" endpoint)
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=us
```

## 5. Configure Environment Variables

Add these to your `.env` file:

```bash
GCS_BUCKET=YOUR_BUCKET_NAME
GOOGLE_APPLICATION_CREDENTIALS=./gcp-key.json
```

## 6. Install the Node.js dependencies

```bash
npm install @google-cloud/storage google-auth-library
```

(These may already be installed — check `package.json`.)

## 7. Run with Google STT

```bash
npm start <meeting-number> --stt-model google
```

This uses `chirp_3` by default. You can also specify `--stt-model google:chirp_2` for the older model.

## Key Notes

- Audio is uploaded to `gs://YOUR_BUCKET/auto-minutes-tmp/` and cleaned up automatically after transcription
- Files longer than 30 minutes are split into segments and transcribed in parallel
- `chirp_3` uses the `us` multi-region endpoint; `chirp_2` uses `us-central1`
