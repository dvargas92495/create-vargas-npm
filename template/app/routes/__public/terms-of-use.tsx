import React from "react";
import getMeta from "@dvargas92495/ui/utils/getMeta";
import TermsOfUse from "@dvargas92495/ui/components/TermsOfUse";

const TermsOfUsePage: React.FC = () => (
  <TermsOfUse name={"{{{displayName}}}"} domain={"{{{DomainName}}}"} />
);

export const meta = getMeta({ title: "Terms of Use" });
export default TermsOfUsePage;