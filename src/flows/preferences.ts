// Retained user preference flows. Provider credentials and route setup are retired.
import type { NyraEnv } from "../../types/env.js";
import { MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS } from "../config.js";
import { sendMessage, buildInlineKeyboard } from "../telegram.js";
import { clearFlowState } from "../db.js";

export async function handlePreferenceFlow(env: NyraEnv, message, from, chat, flowState) {
  const userId = from.id;
  const chatId = chat.id;
  const text = String(message.text || "").trim();

  if (flowState.flowType === "custom_instructions") {
    if (!text) {
      await sendMessage(env, chatId, "Please send some text, or /cancel.");
      return true;
    }
    if (text.length > MAX_CUSTOM_INSTRUCTIONS) {
      await sendMessage(env, chatId, "Too long (max " + MAX_CUSTOM_INSTRUCTIONS + " characters).");
      return true;
    }
    try {
      await env.DB.prepare("UPDATE users SET custom_instructions = ?, updated_at = ? WHERE telegram_id = ?")
        .bind(text, Math.floor(Date.now() / 1000), userId).run();
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "✅ Custom instructions saved.", {
        reply_markup: buildInlineKeyboard([[{ text: "Back to Settings", callback_data: "set:menu" }]])
      });
    } catch (error) {
      await sendMessage(env, chatId, "Could not save. Try again.");
    }
    return true;
  }

  if (flowState.flowType === "personality_edit") {
    const field = flowState.editField;
    const personalityId = flowState.personalityId;
    if (!field || !personalityId) {
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "Invalid flow state.");
      return true;
    }
    let column, maxLength, minimum = 0;
    if (field === "name") { column = "name"; maxLength = 50; minimum = 1; }
    else if (field === "description") { column = "description"; maxLength = MAX_PERSONALITY_DESC; }
    else if (field === "prompt") { column = "prompt"; maxLength = MAX_PERSONALITY_PROMPT; minimum = 1; }
    else {
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "Invalid field.");
      return true;
    }
    if (text.length < minimum || text.length > maxLength) {
      await sendMessage(env, chatId, (field === "name" ? "Name" : field === "description" ? "Description" : "Prompt")
        + " must be " + minimum + "-" + maxLength + " characters.");
      return true;
    }
    try {
      const statement = "UPDATE custom_personalities SET " + column + " = ?, updated_at = ? WHERE personality_id = ? AND telegram_id = ?";
      await env.DB.prepare(statement).bind(text, Math.floor(Date.now() / 1000), personalityId, userId).run();
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "✅ " + field.charAt(0).toUpperCase() + field.slice(1) + " updated.", {
        reply_markup: buildInlineKeyboard([[{ text: "View", callback_data: "myp:view:" + personalityId }]])
      });
    } catch (error) {
      await sendMessage(env, chatId, "Could not update.");
    }
    return true;
  }

  return false;
}
