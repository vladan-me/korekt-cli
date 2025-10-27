import Conf from 'conf';
import dotenv from 'dotenv';

// Load .env file if it exists (quietly)
dotenv.config({ quiet: true });

// Initialize config
const config = new Conf({
  projectName: 'korekt-cli',
});

/**
 * Get the API key from config or environment
 * Priority: 1) config store, 2) .env file
 */
export function getApiKey() {
  const configKey = config.get('apiKey');
  if (configKey) return configKey;

  return process.env.KOREKT_API_KEY || null;
}

/**
 * Set the API key in config store
 */
export function setApiKey(key) {
  config.set('apiKey', key);
}

/**
 * Get the API endpoint URL from config or environment
 * Priority: 1) config store, 2) .env file
 */
export function getApiEndpoint() {
  const configEndpoint = config.get('apiEndpoint');
  if (configEndpoint) return configEndpoint;

  return process.env.KOREKT_API_ENDPOINT || null;
}

/**
 * Set the API endpoint in config store
 */
export function setApiEndpoint(endpoint) {
  config.set('apiEndpoint', endpoint);
}

/**
 * Get the ticket system from config or environment
 * Priority: 1) config store, 2) .env file
 */
export function getTicketSystem() {
  const configTicketSystem = config.get('ticketSystem');
  if (configTicketSystem) return configTicketSystem;

  return process.env.KOREKT_TICKET_SYSTEM || null;
}

/**
 * Set the ticket system in config store
 */
export function setTicketSystem(system) {
  config.set('ticketSystem', system);
}

/**
 * Get all configuration
 */
export function getConfig() {
  return {
    apiKey: getApiKey(),
    apiEndpoint: getApiEndpoint(),
    ticketSystem: getTicketSystem(),
  };
}