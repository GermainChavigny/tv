/**
 * Configuration management
 * Single unified configuration with OS detection
 */

// Detect if running on Windows or Linux
function detectOS() {
  const userAgent = (navigator.userAgentData?.platform ?? navigator.platform).toLowerCase();
  if (userAgent.includes('win')) return 'windows';
  else return 'linux';
}

// L'API tourne sur le même hôte que la page, port 5000. En déduire l'hôte
// permet d'ouvrir l'interface depuis un autre poste du réseau (ex.
// http://192.168.1.12:8000) sans pointer le « localhost » du navigateur.
function detectApiHost() {
  const host = location.hostname || 'localhost';
  return `http://${host}:5000`;
}

// Configuration
const config = {
  os: detectOS(),
  api: {
    host: detectApiHost(),
    endpoints: {
      load: '/load',
      save: '/save',
      tvPower: '/tv-power',
      alarmSettings: '/alarm-settings',
      // Bibliothèque de films (source unique : library.json)
      library: '/movies/library',
      poster: '/poster',        // + /<id>
      subtitle: '/subtitle',    // + /<id>/<lang>
      // Téléchargement (paliers suivants)
      moviesSearch: '/movies/search',
      moviesDownload: '/movies/download',
      moviesStatus: '/movies/status',
      moviesCancel: '/movies/cancel',
      moviesDelete: '/movies/delete',
      // Movie Advisor (recommandations IA + blacklist « Forget »)
      advisorRecommend: '/advisor/recommend',
      advisorForget: '/advisor/forget',
      // Séries (TMDB TV + téléchargement par épisode/saison/série)
      seriesSearch: '/series/search',
      seriesAdd: '/series/add',
      series: '/series',                // + /<id> ; + /<id>/season/<n>
      seriesDownload: '/series/download',
      seriesRecheck: '/series/recheck',
      // Météo (proxy Open-Meteo, sans clé)
      weather: '/weather',
    },
  },
  hardware: {
    tvControl: 'http://192.168.1.19/rpc/Switch.Set',
  },
  player: {
    youtube: {
      autoplay: true,
      controls: true,
      quality: 'hd720',
    },
  },
};

/**
 * Get configuration
 */
export function getConfig() {
  return config;
}

/**
 * Merge custom config (useful for testing or overrides)
 */
export function mergeConfig(customConfig) {
  return deepMerge(config, customConfig);
}

/**
 * Simple deep merge utility
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Export default config
export default getConfig();
