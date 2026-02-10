/**
 * Configuration management with automatic OS detection and environment support
 */

// Detect if running on Windows or Linux
function detectOS() {
    const userAgent = (navigator.userAgentData.platform ?? navigator.platform).toLowerCase();
    if (userAgent.includes('win')) return 'windows';
    else return 'linux';
}

// Base configuration
const baseConfig = {
  environment: 'development', // Will be set from .env or auto-detected
  os: detectOS(),
};

// Development configuration (Windows - local dev)
const devConfig = {
  api: {
    host: 'http://localhost:5000',
    endpoints: {
      load: '/load',
      save: '/save',
      moviesProgress: '/movies-progress',
      moviesList: '/movies-list',
      tvPower: '/tv-power',
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

// Production configuration (Debian - on actual TV box)
const prodConfig = {
  api: {
    host: 'http://localhost:5000',
    endpoints: {
      load: '/load',
      save: '/save',
      moviesProgress: '/movies-progress',
      moviesList: '/movies-list',
      tvPower: '/tv-power',
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
 * Get configuration based on environment
 */
export function getConfig(env = null) {
  const currentEnv = env || baseConfig.environment || 'development';
  const config = currentEnv === 'production' ? prodConfig : devConfig;
  
  return {
    ...baseConfig,
    environment: currentEnv,
    ...config,
  };
}

/**
 * Merge custom config (useful for testing or overrides)
 */
export function mergeConfig(customConfig) {
  const baseEnv = baseConfig.environment || 'development';
  const currentConfig = getConfig(baseEnv);
  return deepMerge(currentConfig, customConfig);
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

/**
 * Set environment (call this early if needed)
 */
export function setEnvironment(env) {
  baseConfig.environment = env;
}

// Export default config
export default getConfig();
