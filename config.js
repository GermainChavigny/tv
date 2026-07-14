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

// Configuration
const config = {
  os: detectOS(),
  api: {
    host: 'http://localhost:5000',
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
