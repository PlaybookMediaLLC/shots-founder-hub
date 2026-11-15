INSERT INTO founder_hub_files.buckets (id, name, public)
VALUES ('audio-files', 'audio-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "audio_files_select_owner" ON founder_hub_files.objects FOR SELECT TO cloud_member USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.user_id())::text = (founder_hub_files.foldername(name))[1]);

CREATE POLICY "audio_files_insert_cloud_member" ON founder_hub_files.objects FOR INSERT TO cloud_member WITH CHECK (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.user_id())::text = (founder_hub_files.foldername(name))[1]);

CREATE POLICY "audio_files_update_owner" ON founder_hub_files.objects FOR UPDATE TO cloud_member USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.user_id())::text = (founder_hub_files.foldername(name))[1]);

CREATE POLICY "audio_files_delete_owner" ON founder_hub_files.objects FOR DELETE TO cloud_member USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.user_id())::text = (founder_hub_files.foldername(name))[1]);
