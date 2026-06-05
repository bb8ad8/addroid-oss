// AdDroid OSS — `@addroid/config` barrel.
//
// 各サブモジュール (paths / config / secrets / storage / crypto / database) を集約し、
// CLI / Web / Worker から単一エントリで参照できるようにします。新しい I/O を追加する
// 場合はサブモジュール側に閉じ込め、本ファイルからは re-export のみ行います。

export {
  AddroidConfigSchema,
  ConfigParseError,
  ExecutionModeSchema,
  defaultAddroidConfig,
  readAddroidConfig,
  writeAddroidConfig,
  type AddroidConfig,
  type ExecutionMode,
} from "./config.js";

export {
  SUPPORTED_ADDROID_LANGUAGES,
  detectLanguageFromAcceptLanguage,
  detectLanguageFromEnv,
  languageLabel,
  languageToHtmlLang,
  languageToLocale,
  normalizeAddroidLanguagePreference,
  resolveAddroidLanguage,
  translateMessage,
  type AddroidLanguage,
  type AddroidLanguagePreference,
  type AddroidMessageDictionary,
  type ResolveAddroidLanguageOptions,
} from "./locale.js";

export {
  ALLOWED_LOCALHOST_HOSTNAMES,
  ensureAddroidPaths,
  homeAnchorPath,
  resolveAddroidHome,
  resolveAddroidPaths,
  resolveWebBinding,
  type AddroidPaths,
} from "./paths.js";

export {
  CIPHERTEXT_FORMAT,
  CiphertextFormatError,
  CryptoNotConfiguredError,
  deriveEncryptionKey,
  getCryptoBoundary,
  validateEncryptionKey,
  type CryptoBoundary,
  type EncryptionKeyValidation,
} from "./crypto.js";

export {
  LocalSecretsSchema,
  SecretsParseError,
  ensureSecretsFilePermissions,
  getLocalSecret,
  inspectSecretsFile,
  readLocalSecrets,
  writeLocalSecrets,
  type LocalSecrets,
  type SecretsFileStatus,
} from "./secrets.js";

export {
  LocalDiskStorage,
  StoragePathError,
  type LocalDiskStorageOptions,
} from "./storage.js";

export {
  parseDatabaseUrl,
  requireDatabaseUrl,
  type DatabaseUrlValidation,
} from "./database.js";

export {
  loadEnvFilesFromRepoRoot,
  parseEnvFile,
  type LoadEnvFilesResult,
} from "./env-files.js";

export {
  SLACK_APP_MANIFEST_TEMPLATE_PATH,
  SLACK_BOT_SCOPES,
  SLACK_SLASH_COMMAND,
  SLACK_SLASH_SUBCOMMANDS,
  buildSlackAppManifest,
  type BuiltSlackAppManifest,
  type SlackAppManifest,
  type SlackAppManifestInput,
  type SlackBotScope,
  type SlackSlashSubcommand,
} from "./slack-manifest.js";

export {
  SLACK_API_BASE_URL,
  SlackApiError,
  SlackTokenValidationError,
  buildSlackInstallationMetadata,
  downloadSlackPrivateFile,
  getSlackFileInfo,
  openSocketModeConnection,
  postSlackMessage,
  redactSecretTail,
  validateSlackInputs,
  verifyBotToken,
  verifySocketModeConnection,
  type SlackAuthInputs,
  type SlackAuthTestResponse,
  type SlackConnectionsOpenResponse,
  type SlackFileInfo,
  type SlackFilesInfoResponse,
  type SlackFetch,
  type SlackInstallationMetadata,
  type SlackPostMessageResponse,
  type SlackSocketModeVerificationResponse,
  type SocketModeChannel,
  type SocketModeChannelHandlers,
  type SocketModeChannelOpener,
} from "./slack-auth.js";

export {
  SLACK_NOTIFICATION_MAX_TEXT_BYTES,
  buildSlackNotificationMessage,
  dispatchResultToError,
  dispatchSlackNotification,
  sanitizeForSlack,
  type ApplyCompletedData,
  type ApplyFailedData,
  type AuthRevokedData,
  type BudgetGuardAlertData,
  type BudgetGuardAutoPausedData,
  type BudgetGuardFailedData,
  type CronFailedData,
  type DailyReportCompletedData,
  type DailyReportFailedData,
  type ExecutionModeLabel,
  type ImprovementPrFailedData,
  type ImprovementPrOpenedData,
  type ImprovementRiskLabel,
  type NotificationAuditInput,
  type NotificationAuditWriter,
  type PrOpenedData,
  type RateLimitState,
  type RateLimitWarningData,
  type SlackBlockActions,
  type SlackBlockContext,
  type SlackBlockDivider,
  type SlackBlockHeader,
  type SlackBlockKitBlock,
  type SlackBlockKitMessage,
  type SlackBlockSection,
  type SlackButtonElement,
  type SlackDispatchOptions,
  type SlackDispatchResult,
  type SlackDispatchState,
  type SlackMrkdwnText,
  type SlackNotificationKind,
  type SlackNotificationPayload,
  type SlackPlainText,
  type SlackTextObject,
} from "./slack-notifications.js";

export {
  DISCORD_API_BASE_URL,
  DISCORD_USER_AGENT,
  DiscordApiError,
  DiscordTokenValidationError,
  buildDiscordInstallationMetadata,
  downloadDiscordAttachment,
  getDiscordChannel,
  postDiscordMessage,
  validateDiscordInputs,
  verifyDiscordBotToken,
  type DiscordApplicationResponse,
  type DiscordAuthInputs,
  type DiscordChannelResponse,
  type DiscordEmbed,
  type DiscordFetch,
  type DiscordInstallationMetadata,
  type DiscordPostMessageOptions,
  type DiscordPostMessageResponse,
} from "./discord-auth.js";

export {
  buildDiscordNotificationMessage,
  dispatchDiscordNotification,
  type DiscordDispatchOptions,
  type DiscordDispatchResult,
  type DiscordDispatchState,
  type DiscordNotificationAuditInput,
  type DiscordNotificationAuditWriter,
  type DiscordNotificationMessage,
  type NotificationKind,
  type NotificationPayload,
} from "./discord-notifications.js";
