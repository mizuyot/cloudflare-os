import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GoogleDriveConfiguratorRpc, GoogleDriveConfiguratorValues,
} from "./google-drive-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.folderId === "string" && values.folderId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Folder" description="Search Drive folders you can open, including shared drives.">
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder="Search folders..."
          loadOptions={query => ui.listFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleDriveConfiguratorRpc, GoogleDriveConfiguratorValues>;
