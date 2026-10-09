export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.status(200).json({
    version: 1,
    updatedAt: new Date().toISOString(),
    platforms: {
      Uber: {
        accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"],
        success_signals: ["Start Ride", "Go to pickup", "Picking up", "Pick up location", "Navigate"],
        view_id_patterns: ["accept", "match", "confirm"]
      },
      Ola: {
        accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Confirm"],
        success_signals: ["Start Ride", "Go to pickup", "Picking up", "OTP SUBMIT", "Navigate"],
        view_id_patterns: ["accept", "confirm"]
      },
      Rapido: {
        accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Confirm"],
        success_signals: ["Start Ride", "Go to pickup", "Picking up", "Client Located", "Navigate"],
        view_id_patterns: ["accept", "order"]
      },
      "Namma Yatri": {
        accept_keywords: ["Confirm", "Accept", "Accept Ride"],
        success_signals: ["Start Ride", "Go to pickup", "Picking up", "Navigate"],
        view_id_patterns: ["accept", "confirm"]
      }
    },
    global: {
      max_ride_cycle_duration_ms: 8000,
      watchdog_interval_ms: 2000,
      health_check_interval_ms: 300000
    }
  });
}
