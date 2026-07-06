import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits
} from "discord.js";

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  UPDATE_CHANNEL_ID,
  STEAM_UPDATE_THREAD_ID,
  ADMIN_ROLE_ID,
  CHECK_INTERVAL_MINUTES
} = process.env;

const MODS_FILE = path.resolve("./workshop_mods.json");
const STATE_FILE = path.resolve("./data/steam_state.json");
const authorCache = new Map();

function isFilled(value) {
  return Boolean(value && !String(value).includes("PASTE_") && String(value).trim() !== "");
}

function parseIntervalMs() {
  const minutes = Number(CHECK_INTERVAL_MINUTES || 5);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : 5;
  return safeMinutes * 60 * 1000;
}

function ensureDataFolder() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`⚠️ Не вдалося прочитати ${file}:`, error);
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDataFolder();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadMods() {
  const data = loadJson(MODS_FILE, { mods: [] });
  if (!Array.isArray(data.mods)) return [];

  return data.mods
    .filter(mod => mod && mod.id)
    .map(mod => ({
      id: String(mod.id).trim(),
      name: mod.name ? String(mod.name).trim() : ""
    }));
}

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
}

function profileUrl(steamId) {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

function formatSteamTime(unixSeconds) {
  if (!unixSeconds) return "невідомо";

  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(unixSeconds) * 1000));
}

function formatNowKyiv() {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
}

function getXmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function getAuthorInfo(steamId) {
  const id = String(steamId || "").trim();

  if (!id) {
    return { name: "невідомий автор", url: "" };
  }

  if (authorCache.has(id)) return authorCache.get(id);

  const fallback = {
    name: `SteamID ${id}`,
    url: profileUrl(id)
  };

  try {
    const response = await fetch(`${profileUrl(id)}?xml=1`, {
      headers: { "User-Agent": "LSP_DiscordBot/1.0" }
    });

    if (!response.ok) {
      authorCache.set(id, fallback);
      return fallback;
    }

    const xml = await response.text();
    const profileName = decodeHtml(getXmlTag(xml, "steamID"));
    const result = {
      name: profileName || fallback.name,
      url: fallback.url
    };

    authorCache.set(id, result);
    return result;
  } catch (error) {
    console.error(`⚠️ Не вдалося отримати Steam nick автора ${id}:`, error.message);
    authorCache.set(id, fallback);
    return fallback;
  }
}

async function fetchWorkshopDetails(mods) {
  if (!mods.length) return [];

  const body = new URLSearchParams();
  body.set("itemcount", String(mods.length));

  mods.forEach((mod, index) => {
    body.set(`publishedfileids[${index}]`, mod.id);
  });

  const response = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) throw new Error(`Steam API HTTP ${response.status}`);

  const json = await response.json();
  return json?.response?.publishedfiledetails || [];
}

async function buildSteamUpdateEmbed(detail, configuredName, oldTime) {
  const id = String(detail.publishedfileid);
  const titleFromSteam = detail.title || "";
  const title = titleFromSteam || configuredName || `Workshop ${id}`;
  const newTime = Number(detail.time_updated || 0);
  const creatorSteamId = detail.creator ? String(detail.creator) : "";
  const author = await getAuthorInfo(creatorSteamId);
  const authorText = author.url ? `[${author.name}](${author.url})` : author.name;

  const fields = [
    {
      name: "Мод",
      value: `[${title}](${workshopUrl(id)})`,
      inline: false
    },
    {
      name: "Автор",
      value: authorText,
      inline: false
    },
    {
      name: "Оновлено в Steam",
      value: formatSteamTime(newTime),
      inline: true
    },
    {
      name: "Перевірено ботом",
      value: formatNowKyiv(),
      inline: true
    }
  ];

  if (oldTime) {
    fields.push({
      name: "Попереднє оновлення",
      value: formatSteamTime(oldTime),
      inline: true
    });
  }

  return new EmbedBuilder()
    .setTitle("☢️ L.S.P | Нова версія моду")
    .setDescription("У Steam Workshop оновився один із модів L.S.P. Перевірте лаунчер і серверну збірку.")
    .addFields(fields)
    .setURL(workshopUrl(id))
    .setColor(0xD6C23A)
    .setFooter({ text: "L.S.P | Steam Workshop Monitor" })
    .setTimestamp();
}

async function getSteamTargetChannel(client) {
  const targetId = isFilled(STEAM_UPDATE_THREAD_ID) ? STEAM_UPDATE_THREAD_ID : UPDATE_CHANNEL_ID;
  if (!isFilled(targetId)) throw new Error("Не заповнено STEAM_UPDATE_THREAD_ID або UPDATE_CHANNEL_ID у .env");
  return await client.channels.fetch(targetId);
}

let checkInProgress = false;

async function checkSteamUpdates(client, reason = "auto") {
  if (checkInProgress) return { ok: false, error: "Перевірка вже виконується" };
  checkInProgress = true;

  try {
    const mods = loadMods();
    if (!mods.length) {
      console.log("⚠️ workshop_mods.json порожній. Додай Steam Workshop ID модів.");
      return { ok: false, error: "workshop_mods.json порожній" };
    }

    const state = loadJson(STATE_FILE, {});
    const details = await fetchWorkshopDetails(mods);
    const byId = new Map(mods.map(mod => [mod.id, mod]));

    let changed = 0;
    let initialized = 0;

    for (const detail of details) {
      const id = String(detail.publishedfileid || "");
      if (!id) continue;

      const result = Number(detail.result || 0);
      if (result !== 1) {
        console.log(`⚠️ Steam не повернув нормальні дані для ${id}. result=${result}`);
        continue;
      }

      const newTime = Number(detail.time_updated || 0);
      if (!newTime) continue;

      const configured = byId.get(id);
      const oldTime = Number(state[id]?.time_updated || 0);
      const steamTitle = detail.title || configured?.name || "";

      state[id] = {
        id,
        title: steamTitle,
        creator: detail.creator || "",
        configured_name: configured?.name || "",
        time_updated: newTime,
        last_seen_at: new Date().toISOString()
      };

      if (!oldTime) {
        initialized += 1;
        continue;
      }

      if (newTime > oldTime) {
        changed += 1;

        try {
          const channel = await getSteamTargetChannel(client);
          const embed = await buildSteamUpdateEmbed(detail, configured?.name, oldTime);
          await channel.send({ embeds: [embed] });
        } catch (error) {
          console.error(`❌ Не вдалося відправити Steam update для ${id}:`, error);
        }
      }
    }

    saveJson(STATE_FILE, state);
    console.log(`✅ Steam check: mods=${mods.length}, changed=${changed}, initialized=${initialized}`);
    return { ok: true, changed, initialized, total: mods.length };
  } catch (error) {
    console.error("❌ Помилка перевірки Steam Workshop:", error);
    return { ok: false, error: error.message };
  } finally {
    checkInProgress = false;
  }
}

if (!isFilled(DISCORD_TOKEN) || !isFilled(CLIENT_ID)) {
  console.error("❌ Не заповнено .env: потрібні DISCORD_TOKEN і CLIENT_ID.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("error", error => console.error("❌ Discord client error:", error));
process.on("unhandledRejection", error => console.error("❌ Unhandled rejection:", error));
process.on("uncaughtException", error => console.error("❌ Uncaught exception:", error));

const updateCommand = new SlashCommandBuilder()
  .setName("update")
  .setDescription("Опублікувати оновлення L.S.P.")
  .addStringOption(option => option.setName("назва").setDescription("Назва оновлення").setRequired(true))
  .addStringOption(option => option.setName("зміни").setDescription("Що змінено. Розділяй пункти через ;").setRequired(true))
  .addStringOption(option =>
    option
      .setName("рестарт")
      .setDescription("Чи потрібен рестарт сервера?")
      .setRequired(true)
      .addChoices(
        { name: "Так, потрібен рестарт", value: "Так" },
        { name: "Ні, без рестарту", value: "Ні" }
      )
  )
  .addStringOption(option => option.setName("примітка").setDescription("Додаткова примітка").setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();

const checkModsCommand = new SlashCommandBuilder()
  .setName("checkmods")
  .setDescription("Перевірити L.S.P моди у Steam Workshop.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON();

const commands = [updateCommand, checkModsCommand];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (isFilled(GUILD_ID)) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash-команди зареєстровані для сервера.");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("⚠️ GUILD_ID не вказаний. Slash-команди зареєстровані глобально, можуть зʼявитися не одразу.");
  }
}

function hasAccess(interaction) {
  const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  if (isFilled(ADMIN_ROLE_ID)) {
    const hasAdminRole = interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID);
    return Boolean(hasAdminRole || hasManageGuild);
  }

  return Boolean(hasManageGuild);
}

function formatChanges(text) {
  const lines = String(text || "").split(";").map(item => item.trim()).filter(Boolean);
  if (!lines.length) return "• Без опису змін.";
  return lines.map(item => `• ${item}`).join("\n");
}

async function sendManualUpdate(interaction) {
  const title = interaction.options.getString("назва");
  const changesRaw = interaction.options.getString("зміни");
  const restart = interaction.options.getString("рестарт");
  const note = interaction.options.getString("примітка");

  const descriptionParts = [
    `**Дата/час:** ${formatNowKyiv()}`,
    "",
    "**Що змінено:**",
    formatChanges(changesRaw),
    "",
    `**Рестарт сервера:** ${restart}`
  ];

  if (note && note.trim() !== "") {
    descriptionParts.push("", `**Примітка:** ${note.trim()}`);
  }

  let targetChannel = interaction.channel;

  if (isFilled(UPDATE_CHANNEL_ID)) {
    try {
      targetChannel = await client.channels.fetch(UPDATE_CHANNEL_ID);
    } catch (error) {
      console.error("⚠️ Не вдалося знайти UPDATE_CHANNEL_ID, пост буде відправлено в поточний канал.", error);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`☢️ Оновлення L.S.P — ${title}`)
    .setDescription(descriptionParts.join("\n"))
    .setColor(0xD6C23A)
    .setFooter({ text: "L.S.P | Updates" })
    .setTimestamp();

  try {
    await targetChannel.send({ embeds: [embed] });
    await interaction.reply({ content: "✅ Оновлення відправлено в канал.", ephemeral: true });
  } catch (error) {
    console.error("❌ Не вдалося відправити /update пост:", error);

    const targetInfo = targetChannel?.id ? `ID каналу/ветки: ${targetChannel.id}` : "Канал не визначено";
    const message = [
      "❌ Бот не зміг відправити пост.",
      "",
      "**Причина:** найчастіше це немає прав у каналі/ветці.",
      targetInfo,
      "",
      "Дай ролі бота права: View Channel, Send Messages, Embed Links, Read Message History.",
      "Якщо це ветка — ще Send Messages in Threads і доступ до батьківського каналу."
    ].join("\n");

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
}

client.once("ready", async () => {
  console.log(`✅ Бот запущений як ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("❌ Не вдалося зареєструвати slash-команди:", error);
  }

  await checkSteamUpdates(client, "startup");

  const intervalMs = parseIntervalMs();
  setInterval(() => checkSteamUpdates(client, "auto"), intervalMs);
  console.log(`✅ Steam Workshop watcher запущений. Інтервал: ${intervalMs / 60000} хв.`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!hasAccess(interaction)) {
    await interaction.reply({ content: "❌ У тебе немає доступу до цієї команди.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "update") {
    await sendManualUpdate(interaction);
    return;
  }

  if (interaction.commandName === "checkmods") {
    await interaction.deferReply({ ephemeral: true });
    const result = await checkSteamUpdates(client, "manual");

    if (!result?.ok) {
      await interaction.editReply(`❌ Помилка перевірки Steam: ${result?.error || "невідома помилка"}`);
      return;
    }

    await interaction.editReply(
      `✅ Перевірка завершена. Модів: ${result.total}. Нових оновлень: ${result.changed}. Ініціалізовано: ${result.initialized}.`
    );
  }
});

client.login(DISCORD_TOKEN);
