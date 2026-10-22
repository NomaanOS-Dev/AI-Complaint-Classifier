CREATE TABLE complaint_analyses (
  complaint_id uuid PRIMARY KEY REFERENCES complaints(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('payment', 'refund', 'delivery', 'account', 'technical', 'product_quality', 'other')),
  sentiment text NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  priority_score integer NOT NULL CHECK (priority_score BETWEEN 0 AND 100),
  priority_label text NOT NULL CHECK (priority_label IN ('low', 'medium', 'high', 'urgent')),
  reasoning_summary text NOT NULL CHECK (char_length(reasoning_summary) BETWEEN 1 AND 300),
  suggested_reply text NOT NULL CHECK (char_length(suggested_reply) BETWEEN 1 AND 1200),
  model_name text NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 64),
  analyzed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (priority_score < 25 AND priority_label = 'low') OR
    (priority_score >= 25 AND priority_score < 50 AND priority_label = 'medium') OR
    (priority_score >= 50 AND priority_score < 80 AND priority_label = 'high') OR
    (priority_score >= 80 AND priority_label = 'urgent')
  )
);

CREATE INDEX complaint_analyses_analyzed_at_idx ON complaint_analyses(analyzed_at DESC);
