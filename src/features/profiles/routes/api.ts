import { apiFetch } from "@/client/api";
import {
  MyProfile,
  PublicReusableSpeakerProfile,
  ReusableSpeakerProfile,
  type SaveMyProfileInput,
} from "../schema";

const api = "/api/v1";

export const getMyProfile = () => apiFetch(`${api}/speaker-profile`, { schema: MyProfile });

export const saveMyProfile = (input: SaveMyProfileInput) => apiFetch(`${api}/speaker-profile`, {
  method: "PUT",
  body: input,
  schema: ReusableSpeakerProfile,
});

export const getPublicProfile = (slug: string) => apiFetch(
  `${api}/public/speakers/${encodeURIComponent(slug)}`,
  { schema: PublicReusableSpeakerProfile },
);
