// src/supabaseClient.js
import "react-native-url-polyfill/auto"; 
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://sldzbngcrrgmzuthtnyy.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZHpibmdjcnJnbXp1dGh0bnl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE3NDI4NTAsImV4cCI6MjA3NzMxODg1MH0.82K4dbV1Wj-jWVLGrDTeq-dYYgx4DEK9-Q5Lm6v7fv8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
