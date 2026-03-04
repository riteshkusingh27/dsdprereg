const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const nodemailer = require("nodemailer");

const credentials = require("../google-sheet-api.json");

const PRIVATE_KEY = (credentials.private_key || "").replace(/\\n/g, "\n");

if (!credentials.client_email || !PRIVATE_KEY) {
  throw new Error("google-sheet-api.json is missing client_email or private_key");
}

if (!PRIVATE_KEY.includes("BEGIN PRIVATE KEY") || !PRIVATE_KEY.includes("END PRIVATE KEY")) {
  throw new Error("google-sheet-api.json private_key format is invalid (missing PEM markers)");
}

const SHEET_ID =
  process.env.GOOGLE_SHEET_ID || "1FEB2SbX7AAPLhQxPE7IHmmBGBbYxnNj6iVRPBuavic0";

const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || process.env.MAIL_FROM;
const SMTP_PASS = process.env.SMTP_PASS || process.env.BREVO_API_KEY;

const mailTransport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

// Google Auth
const auth = new JWT({
  email: credentials.client_email,
  key: PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const validateGoogleAuth = async () => {
  try {
    await auth.authorize();
    console.info("Google service account JWT verified");
  } catch (err) {
    console.error("Google service account auth failed", err);
    throw err;
  }
};

// check for email already registered
const isEmailRegistered = async (email) => {
  const doc = new GoogleSpreadsheet(SHEET_ID, auth);

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];

  try {
    await sheet.loadHeaderRow();
  } catch {
    return false;
  }

  const rows = await sheet.getRows();
  const normalizedEmail = email.trim().toLowerCase();

  const exists = rows.some((row) => {
    const sheetEmail = row.get("email");
    if (!sheetEmail) return false;

    return sheetEmail.trim().toLowerCase() === normalizedEmail;
  });

  return exists;
};

const appendRow = async ({ name, email, note }) => {
  const doc = new GoogleSpreadsheet(SHEET_ID, auth);

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];

  const requiredHeaders = ["name", "email", "note", "created_at"];

  try {
    await sheet.loadHeaderRow();
  } catch {
    await sheet.setHeaderRow(requiredHeaders);
  }

  await sheet.addRow({
    name,
    email,
    note,
    created_at: new Date().toISOString(),
  });
};

const sendConfirmationEmail = async ({ name, email }) => {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP credentials are not configured");
  }

  const senderEmail = process.env.MAIL_FROM || SMTP_USER || "no-reply@example.com";

  const info = await mailTransport.sendMail({
    from: { address: senderEmail, name: "Pre-Registration" },
    sender: senderEmail,
    to: [{ address: email, name }],
    subject: "Registration received",
    html: `<div style="background:#0f0f17;padding:30px;font-family:Arial,Helvetica,sans-serif;">
  <table align="center" width="520" style="background:#151523;border-radius:10px;color:#ffffff;text-align:center;padding:30px;">
    
    <tr>
      <td>
        <h1 style="margin:0;color:#ff3c5f;">🎮 DSD Premium Gaming Café</h1>
        <p style="color:#cfcfe6;margin-top:5px;">Pre-Registration Confirmed</p>
      </td>
    </tr>

    <tr>
      <td style="padding:25px 0;">
        <p style="font-size:16px;color:#e6e6f0;">
          Hi <b>${name || "Gamer"}</b>,
        </p>

        <p style="color:#b8b8c8;line-height:1.5;">
          Your pre-registration has been received successfully.
          <br>
          Get ready for the launch of the ultimate gaming arena.
        </p>
      </td>
    </tr>

    <tr>
      <td style="background:#1c1c2b;border-radius:8px;padding:15px;">
        <b style="color:#ff3c5f;">Grand Opening</b>
        <br>
        <span style="font-size:18px;">13 March</span>
      </td>
    </tr>

    <tr>
      <td style="padding-top:25px;color:#9a9aa5;font-size:13px;">
        See you at the arena. 🎮
        <br>
        <b>DSD Premium Gaming Café</b>
      </td>
    </tr>

  </table>
</div>`,
  });

  return info;
};

module.exports = async function handler(req, res) {

  await validateGoogleAuth();

  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === "POST") {
    try {

      const { name, email, note = "" } = req.body;

      if (!name || !email) {
        return res.status(400).json({
          error: "name and email are required",
        });
      }

      const alreadyRegistered = await isEmailRegistered(email);

      if (alreadyRegistered) {
        return res.status(409).json({
          error: "This email is already registered",
        });
      }

      await appendRow({ name, email, note });

      await sendConfirmationEmail({ name, email });

      return res.status(201).json({
        status: "created",
      });

    } catch (err) {

      return res.status(500).json({
        error: "Unable to create record",
        detail: err?.message || "Unknown error",
      });

    }
  }

  return res.status(405).json({
    error: "Method not allowed",
  });
};