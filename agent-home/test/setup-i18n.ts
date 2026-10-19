import { setFallbackMessages } from "@/i18n/client";
import { readLocaleFiles } from "@/i18n/load";

setFallbackMessages(readLocaleFiles("en"));
