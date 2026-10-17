// Nyra — setup-wizard flows barrel.
//
// `src/flows.js` re-exports this so the historical import path stays valid.
// The two wizards (connection, route) are independent; the connection wizard
// drives the route wizard's step machine rather than duplicating it.
export {
  flowPromptLabel, flowPromptDescription, flowPromptBaseUrl,
  flowPromptApiKey, flowPromptModel, flowPromptReview,
  flowPromptCapabilities
} from "./connection-prompts.js";

export {
  flowFetchModels, showModelPage, flowSelectModel
} from "./model-picker.js";

export {
  startAddRouteFlow, startEditRouteFlow, routePromptProvider,
  routePromptBaseUrl, routePromptModels, routePromptTokens,
  routePromptReview, finalizeRouteFromFlow
} from "./route.js";

export {
  startAddConnectionFlow, startEditConnectionFlow, handleFlowMessage,
  handleFlowSkip, finalizeConnectionFromFlow
} from "./connection.js";
