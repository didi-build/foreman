import { useSearchParams } from "react-router-dom";
import { GALLERY_PROBE_MARKER } from "./gallery-probe-marker.js";
import { GalleryShot } from "./GalleryShot.js";
import { galleryEntries } from "./registry.js";
import { SHOT_ATTRIBUTES, SHOT_PARAMS } from "./shot-mode.js";
import "./gallery.css";

function PropsTable({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props);
  if (entries.length === 0) {
    return <p className="gallery-muted">No props</p>;
  }
  return (
    <table className="gallery-props">
      <thead>
        <tr>
          <th>Prop</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <td>
              <code>{key}</code>
            </td>
            <td>
              <code>{JSON.stringify(value)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function App() {
  const [params] = useSearchParams();
  const shotEntry = params.get(SHOT_PARAMS.entry);
  const shotVariant = params.get(SHOT_PARAMS.variant);
  if (shotEntry !== null && shotVariant !== null) {
    return <GalleryShot entryId={shotEntry} variantName={shotVariant} />;
  }
  return (
    <div className="gallery-root">
      <span className="gallery-probe-marker" hidden>
        {GALLERY_PROBE_MARKER}
      </span>
      <header className="gallery-header">
        <h1>Component gallery</h1>
        <p className="gallery-muted">
          Specs live in <code>design/&lt;area&gt;/&lt;feature&gt;/</code>;
          implementations in <code>components/</code>. See{" "}
          <code>docs/component-gallery.md</code>.
        </p>
      </header>
      <main className="gallery-main">
        {galleryEntries.map((entry) => {
          const Component = entry.component;
          return (
            <section
              key={entry.id}
              className="gallery-card"
              id={entry.id}
              {...{
                [SHOT_ATTRIBUTES.entry]: entry.id,
                [SHOT_ATTRIBUTES.spec]: entry.specPath,
              }}
            >
              <div className="gallery-card-head">
                <h2>{entry.title}</h2>
                <p className="gallery-muted">
                  Spec: <code>{entry.specPath}</code>
                </p>
              </div>
              <details className="gallery-spec">
                <summary>Spec excerpt</summary>
                <pre>{entry.specMarkdown}</pre>
              </details>
              <div className="gallery-variants">
                {entry.variants.map((variant) => (
                  <div
                    key={variant.name}
                    className="gallery-variant"
                    {...{ [SHOT_ATTRIBUTES.variant]: variant.name }}
                  >
                    <h3>{variant.name}</h3>
                    <div className="gallery-preview">
                      <Component {...variant.props} />
                    </div>
                    <PropsTable props={variant.props} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
