import nodemailer from "nodemailer";
import { MAIL_FROM, MAIL_PASS, MAIL_TO, MAIL_USER } from "./const.js";
import { MAIL_DEBUG_TO, NOTIFY_LEVEL_DEBUG } from "./define.js";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // STARTTLS
  // ignoreTLS: true,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS, // use an app password, not your Gmail password
  },
  // logger: true, // shows detailed logs
  // debug: true, // shows SMTP traffic
});

export async function sendEmail(subject, text, level = NOTIFY_LEVEL_DEBUG) {
  try {
    console.log("🔍 Verifying SMTP connection...");
    await transporter.verify(); // checks the connection
    console.log("✅ SMTP connection verified successfully!");

    await transporter.sendMail({
      from: MAIL_FROM,
      // to: level === NOTIFY_LEVEL_DEBUG ? MAIL_DEBUG_TO : MAIL_TO,
      to: MAIL_DEBUG_TO, // for testing, send all emails to debug address
      subject,
      text,
    });
    console.log(`📧 Email sent: ${subject}`);
  } catch (err) {
    console.error("🚨 Email failed:", err.message);
  }
}
