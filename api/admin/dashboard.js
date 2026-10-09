import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.ADMIN_TOKEN;
  
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    
    const platforms = ['Ola', 'Rapido', 'Uber', 'Namma Yatri'];
    const types = ['NO_RIDE_DETECTED_5MIN', 'ACCEPT_FAILED', 'SUCCESS_TIMEOUT', 'CREDIT_FAILED'];
    
    const stats = {};
    
    for (const platform of platforms) {
      stats[platform] = {};
      for (const type of types) {
        const todayCount = parseInt(await redis.get(`counter:${platform}:${type}:${today}`) || 0);
        const yesterdayCount = parseInt(await redis.get(`counter:${platform}:${type}:${yesterday}`) || 0);
        stats[platform][type] = { today: todayCount, yesterday: yesterdayCount, change: todayCount - yesterdayCount };
      }
    }
    
    const totalToday = parseInt(await redis.get(`counter:total:${today}`) || 0);
    const totalYesterday = parseInt(await redis.get(`counter:total:${yesterday}`) || 0);

    let totalErrors = 0;
    for (const p of Object.keys(stats)) {
      for (const t of Object.keys(stats[p])) totalErrors += stats[p][t].today;
    }
    const healthScore = Math.max(0, 100 - Math.floor(totalErrors / 100));

    return res.status(200).json({
      date: today,
      totalReports: totalToday,
      yesterdayReports: totalYesterday,
      healthScore,
      platforms: stats,
      alert: healthScore < 90 ? "⚠️ Platform issue detected" : "✅ All systems normal"
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    return res.status(500).json({ error: 'Dashboard failed' });
  }
}
