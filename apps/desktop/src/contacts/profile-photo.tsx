import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@anlg/ui/components/ui/button";

import { AvatarUploadButton, ContactImage } from "./contact-avatar";
import { ContactFacehash } from "./shared";

export function ProfilePhoto({
  userId,
  name,
  localPhoto,
  onSave,
}: {
  userId: string;
  name: string;
  localPhoto: string | null;
  onSave: (url: string | null) => Promise<void>;
}) {
  const { t } = useLingui();
  const save = useMutation({
    scope: { id: `profile-photo:${userId}` },
    mutationFn: async (photo: string | null) => {
      await onSave(photo);
      return photo;
    },
  });
  const photo =
    save.isPending || save.isError
      ? save.variables
      : save.isSuccess
        ? save.data
        : localPhoto;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <AvatarUploadButton
          label={t`Change photo`}
          onUpload={(value) => {
            save.mutate(value);
          }}
        >
          {photo ? (
            <ContactImage src={photo} size={64} />
          ) : (
            <ContactFacehash name={name} size={64} />
          )}
        </AvatarUploadButton>
        {photo && (
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              save.mutate(null);
            }}
          >
            <Trans>Remove photo</Trans>
          </Button>
        )}
      </div>
      {save.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          <Trans>Saving...</Trans>
        </p>
      )}
      {save.isError && (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-destructive text-sm">
            <Trans>Couldn't save your profile. Try again.</Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => save.mutate(save.variables ?? null)}
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
