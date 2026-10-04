"use client";

import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import StatsRow from "@/components/StatsRow/StatsRow";
import PaperControls from "@/components/PaperControls/PaperControls";
import { useFeed } from "@/lib/useFeed";
import styles from "./page.module.css";

const API_URL = "/api/paper";

export default function Page() {
  const feed = useFeed(API_URL);

  return (
    <div className="card">
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} />
      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      <PaperControls meta={feed.meta} latest={feed.latest} connection={feed.connection} />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart events={feed.events} latest={feed.latest} />
          </div>
        </div>
        <div className={styles.right}>
          <DecisionPanel latest={feed.latest} />
          <Feed events={feed.events} />
        </div>
      </div>
    </div>
  );
}
