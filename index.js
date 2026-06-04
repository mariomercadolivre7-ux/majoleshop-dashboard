const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ML_CLIENT_ID = '8527794874327769';
const ML_CLIENT_SECRET = '47NZaXl4kxlXMONrMetsk0ZvYtwdKapZ';
const ML_API = 'https://api.mercadolibre.com';
const ML_REDIRECT_URI = 'https://majoleshop-dashboard.onrender.com/auth/callback';

let tokenData = null;

app.get('/auth/login', (req, res) => {
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth=error');
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', ML_CLIENT_ID);
    params.append('client_secret', ML_CLIENT_SECRET);
    params.append('code', code);
    params.append('redirect_uri', ML_REDIRECT_URI);

    const r = await axios.post(`${ML_API}/oauth/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
    });
    tokenData = { ...r.data, created_date: Date.now() / 1000 };
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Auth error:', JSON.stringify(err.response?.data || err.message));
    res.redirect('/?auth=error');
  }
});

async function getToken() {
  if (!tokenData) return null;
  if (Date.now() / 1000 < tokenData.created_date + tokenData.expires_in - 60) return tokenData.access_token;
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', ML_CLIENT_ID);
    params.append('client_secret', ML_CLIENT_SECRET);
    params.append('refresh_token', tokenData.refresh_token);
    const r = await axios.post(`${ML_API}/oauth/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
    });
    tokenData = { ...r.data, created_date: Date.now() / 1000 };
    return tokenData.access_token;
  } catch { return null; }
}

app.get('/api/status', (req, res) => res.json({ authenticated: !!tokenData }));

app.get('/api/dashboard', async (req, res) => {
  const token = await getToken();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { days = 30 } = req.query;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - parseInt(days));
  try {
    const H = { Authorization: `Bearer ${token}` };
    const { data: me } = await axios.get(`${ML_API}/users/me`, { headers: H });
    let orders = [], offset = 0, total = 1;
    while (offset < total && offset < 500) {
      const { data } = await axios.get(
        `${ML_API}/orders/search?seller=${me.id}&order.status=paid&order.date_created.from=${dateFrom.toISOString()}&limit=50&offset=${offset}&sort=date_desc`,
        { headers: H });
      total = data.paging.total; orders = orders.concat(data.results); offset += 50;
    }
    let cancelled = 0;
    try { const {data} = await axios.get(`${ML_API}/orders/search?seller=${me.id}&order.status=cancelled&order.date_created.from=${dateFrom.toISOString()}&limit=1`,{headers:H}); cancelled = data.paging.total; } catch{}
    const rev = orders.reduce((s,o) => s+(o.total_amount||0), 0);
    const fees = orders.reduce((s,o) => s+(o.payments?.reduce((a,p) => a+(p.marketplace_fee||0),0)||0), 0);
    const ship = orders.reduce((s,o) => s+(o.shipping?.cost||0), 0);
    const tax = rev * 0.04;
    const profit = rev - fees - ship - tax;
    const pm = {};
    orders.forEach(o => o.order_items?.forEach(i => {
      const id = i.item?.id||'x';
      if (!pm[id]) pm[id] = {id, title: i.item?.title||'-', revenue:0, quantity:0};
      pm[id].revenue += i.unit_price * i.quantity; pm[id].quantity += i.quantity;
    }));
    const top = Object.values(pm).sort((a,b)=>b.revenue-a.revenue).slice(0,10)
      .map(p => ({...p, percentage: rev>0?+((p.revenue/rev)*100).toFixed(1):0}));
    const dm = {};
    orders.forEach(o => {
      const d = o.date_created?.split('T')[0]; if(!d) return;
      if (!dm[d]) dm[d] = {date:d, revenue:0, orders:0, profit:0};
      dm[d].revenue += o.total_amount||0; dm[d].orders++;
      dm[d].profit += (o.total_amount||0) - (o.payments?.reduce((a,p)=>a+(p.marketplace_fee||0),0)||0) - (o.shipping?.cost||0) - (o.total_amount||0)*0.04;
    });
    res.json({
      summary: { revenue:+rev.toFixed(2), profit:+profit.toFixed(2),
        profit_margin: rev>0?+((profit/rev)*100).toFixed(2):0,
        orders:orders.length, cancelled, avg_ticket:orders.length?+(rev/orders.length).toFixed(2):0,
        avg_profit:orders.length?+(profit/orders.length).toFixed(2):0,
        fees:+fees.toFixed(2), fees_pct:rev>0?+((fees/rev)*100).toFixed(1):0,
        shipping:+ship.toFixed(2), shipping_pct:rev>0?+((ship/rev)*100).toFixed(1):0,
        taxes:+tax.toFixed(2), taxes_pct:4 },
      topProducts: top,
      dailyData: Object.values(dm).sort((a,b)=>a.date.localeCompare(b.date)),
      orders: orders.slice(0,50).map(o => ({
        id:o.id, date:o.date_created, title:o.order_items?.[0]?.item?.title||'-',
        sku:o.order_items?.[0]?.item?.seller_sku||'-', quantity:o.order_items?.[0]?.quantity||1,
        value:o.total_amount||0, fee:o.payments?.reduce((a,p)=>a+(p.marketplace_fee||0),0)||0,
        shipping:o.shipping?.cost||0, status:o.status }))
    });
  } catch(err) { res.status(500).json({error:err.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
