import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. " +
      "Copy .env.example to .env and fill in your credentials."
  );
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey
);
