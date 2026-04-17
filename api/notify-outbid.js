// api/notify-outbid.js
// Vercel serverless function — sends outbid email via Resend
// Environment variables required:
//   RESEND_API_KEY  — your Resend sending key
//   SUPABASE_URL    — https://haijshusgcbdexfueunr.supabase.co
//   SUPABASE_ANON   — your anon public key

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    outbid_wallet,
    new_bidder,
    new_amount,
    auction_id,
    art_title,
    auction_url,
  } = req.body || {};

  if (!outbid_wallet || !new_amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL  || "https://haijshusgcbdexfueunr.supabase.co";
  const SUPABASE_ANON = process.env.SUPABASE_ANON;
  const RESEND_KEY    = process.env.RESEND_API_KEY;

  if (!RESEND_KEY || !SUPABASE_ANON) {
    return res.status(500).json({ error: "Server misconfigured — missing env vars" });
  }

  // 1. Look up the outbid wallet's email from Supabase
  let email = null;
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/collector_notifications?wallet_address=eq.${encodeURIComponent(outbid_wallet)}&auction_id=eq.${encodeURIComponent(auction_id)}&limit=1&select=email`,
      { headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON } }
    );
    const rows = await sbRes.json();
    if (Array.isArray(rows) && rows.length > 0) email = rows[0].email;
  } catch (e) {
    return res.status(500).json({ error: "Supabase lookup failed: " + e.message });
  }

  if (!email) {
    // No email registered for this wallet — nothing to send
    return res.status(200).json({ sent: false, reason: "No email registered" });
  }

  // 2. Format display values
  const shortOutbid  = outbid_wallet.slice(0,6)  + "…" + outbid_wallet.slice(-4);
  const shortBidder  = (new_bidder || "").slice(0,6) + "…" + (new_bidder || "").slice(-4);
  const title        = art_title || "Àpótí Ọlọ́wẹ̀";
  const url          = auction_url || "https://kaysworks.com/auction";

  // 3. Send email via Resend
  const emailBody = {
    from:    `Àpótí Ọlọ́wẹ̀ Auction <auction@mail.kaysworks.com>`,
    to:      [email],
    subject: `You've been outbid — ${new_amount} on ${title}`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Outbid Notice</title>
</head>
<body style="margin:0;padding:0;background:#1e1510;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1510;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#2a1c14;border:1px solid rgba(196,132,90,0.25);border-radius:6px;overflow:hidden;max-width:560px;width:100%">

        <!-- Header -->
        <tr>
          <td style="padding:28px 32px 20px;border-bottom:1px solid rgba(196,132,90,0.18)">
            <p style="margin:0 0 4px;font-family:'Georgia',serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#c4845a">Kay's Works · Live Auction</p>
            <h1 style="margin:0;font-family:'Georgia',serif;font-size:26px;font-weight:400;color:#e8d5b0;line-height:1.2">${title}</h1>
          </td>
        </tr>

        <!-- Alert -->
        <tr>
          <td style="padding:24px 32px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(158,79,46,0.12);border:1px solid rgba(196,132,90,0.3);border-radius:4px">
              <tr><td style="padding:18px 20px">
                <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4845a;font-family:'Georgia',serif">Outbid alert</p>
                <p style="margin:0;font-size:22px;color:#e8d5b0;font-family:'Georgia',serif">You've been outbid at <strong style="color:#c4845a">${new_amount}</strong></p>
                <p style="margin:8px 0 0;font-size:13px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">${shortBidder} placed a higher bid on the piece you were leading.</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- Your wallet -->
        <tr>
          <td style="padding:0 32px 20px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">Your wallet</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:13px;color:#c4845a;font-style:italic;font-family:'Georgia',serif">${shortOutbid}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8070;font-family:'Georgia',serif">New leading bid</span>
                </td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(196,132,90,0.12)">
                  <span style="font-size:16px;color:#e8d5b0;font-weight:600;font-family:'Georgia',serif">${new_amount}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:4px 32px 32px;text-align:center">
            <a href="${url}" style="display:inline-block;background:#9e4f2e;color:#f5ede0;text-decoration:none;font-family:'Georgia',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px">Return to auction</a>
            <p style="margin:18px 0 0;font-size:12px;color:#9a8070;font-style:italic;font-family:'Georgia',serif">The auction is still live. You can still reclaim your lead.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid rgba(196,132,90,0.18);text-align:center">
            <p style="margin:0;font-size:11px;color:#4a3228;font-family:'Georgia',serif">© Kay's Works · <a href="https://kaysworks.com" style="color:#4a3228">kaysworks.com</a></p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body:    JSON.stringify(emailBody),
    });
    const resendData = await resendRes.json();
    if (!resendRes.ok) throw new Error(resendData.message || "Resend error");
    return res.status(200).json({ sent: true, id: resendData.id });
  } catch (e) {
    return res.status(500).json({ error: "Email send failed: " + e.message });
  }
}
