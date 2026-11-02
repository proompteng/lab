#[derive(Default)]
pub(super) struct ProbeOutput {
    output: Vec<u8>,
    query: Vec<u8>,
}

impl ProbeOutput {
    pub(super) fn append(&mut self, data: &[u8]) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(
            self.output.len() + data.len() <= 1 << 20,
            "probe output exceeded its limit"
        );
        self.output.extend_from_slice(data);
        self.query.extend_from_slice(data);
        let queries: [(&[u8], &[u8]); 5] = [
            (b"\x1b]10;?\x07", b"\x1b]10;rgb:ffff/ffff/ffff\x07"),
            (b"\x1b]11;?\x07", b"\x1b]11;rgb:0000/0000/0000\x07"),
            (b"\x1b]10;?\x1b\\", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
            (b"\x1b]11;?\x1b\\", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
            (b"\x1b[5n", b"\x1b[0n"),
        ];
        let mut replies = Vec::new();
        let mut consumed = 0;
        while consumed < self.query.len() {
            let remaining = &self.query[consumed..];
            if let Some((query, reply)) = queries
                .iter()
                .find(|(query, _)| remaining.starts_with(query))
            {
                replies.extend_from_slice(reply);
                consumed += query.len();
            } else if queries
                .iter()
                .any(|(query, _)| query.starts_with(remaining))
            {
                break;
            } else {
                consumed += 1;
            }
        }
        self.query.drain(..consumed);
        Ok(replies)
    }

    pub(super) fn take_marker(&mut self, marker: &[u8]) -> bool {
        let Some(offset) = self
            .output
            .windows(marker.len())
            .position(|window| window == marker)
        else {
            return false;
        };
        self.output.drain(..offset + marker.len());
        true
    }

    pub(super) fn diagnostic_tail(&self) -> String {
        String::from_utf8_lossy(&self.output[self.output.len().saturating_sub(4096)..]).into_owned()
    }
}

#[test]
fn markers_received_during_heartbeats_remain_available() {
    let mut output = ProbeOutput::default();
    output.append(b"\x1eTENGRI_IO_END_124\x1f").unwrap();
    output.append(b"shell prompt").unwrap();
    assert!(output.take_marker(b"\x1eTENGRI_IO_END_124\x1f"));
    assert!(!output.take_marker(b"\x1eTENGRI_IO_END_124\x1f"));
}

#[test]
fn editor_readiness_requires_rendered_output_instead_of_shell_echo() {
    let mut output = ProbeOutput::default();
    output.append(&editor_probe_command()).unwrap();
    assert!(!output.take_marker(EDITOR_READY));
    output.append(b"\x1b[3;8HTENGRI_EDITOR_").unwrap();
    assert!(!output.take_marker(EDITOR_READY));
    output.append(b"READY\x1b[K").unwrap();
    assert!(output.take_marker(EDITOR_READY));
    assert!(!output.take_marker(EDITOR_READY));
}

#[test]
fn split_and_coalesced_markers_keep_the_remaining_output() {
    let mut output = ProbeOutput::default();
    output.append(b"prompt\x1eFIRST").unwrap();
    assert!(!output.take_marker(b"\x1eFIRST\x1f"));
    output.append(b"\x1f\x1eSECOND\x1f").unwrap();
    assert!(output.take_marker(b"\x1eFIRST\x1f"));
    assert!(output.take_marker(b"\x1eSECOND\x1f"));
}

#[test]
fn accumulated_probe_output_keeps_its_byte_bound() {
    let mut output = ProbeOutput::default();
    output.append(&vec![b'x'; 1 << 20]).unwrap();
    assert!(output.append(b"x").is_err());
}

#[test]
fn failure_diagnostics_only_include_the_bounded_remaining_output() {
    let mut output = ProbeOutput::default();
    output.append(b"consumed\x1eREADY\x1f").unwrap();
    assert!(output.take_marker(b"\x1eREADY\x1f"));
    assert_eq!(output.diagnostic_tail(), "");
    output.append(&vec![b'x'; 4096]).unwrap();
    output.append(b"read failed").unwrap();
    let diagnostic = output.diagnostic_tail();
    assert_eq!(diagnostic.len(), 4096);
    assert!(diagnostic.ends_with("read failed"));
    assert!(!diagnostic.contains("consumed"));
}

#[test]
fn terminal_color_queries_receive_replies_in_both_terminator_forms() {
    let mut output = ProbeOutput::default();
    assert_eq!(
        output.append(b"\x1b]10;?\x07\x1b]11;?\x1b\\").unwrap(),
        b"\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0000/0000/0000\x1b\\"
    );
}

#[test]
fn fragmented_color_queries_reply_once_without_losing_markers() {
    let query = b"\x1b]11;?\x1b\\";
    for split in 0..=query.len() {
        let mut output = ProbeOutput::default();
        let mut replies = output.append(&query[..split]).unwrap();
        replies.extend(output.append(&query[split..]).unwrap());
        replies.extend(output.append(b"\x1eREADY\x1f").unwrap());
        assert_eq!(
            replies, b"\x1b]11;rgb:0000/0000/0000\x1b\\",
            "split {split}"
        );
        assert!(output.take_marker(b"\x1eREADY\x1f"));
        assert!(output.append(b"later output").unwrap().is_empty());
    }
}

#[test]
fn ordinary_output_and_color_setting_sequences_do_not_generate_replies() {
    let mut output = ProbeOutput::default();
    for data in [
        b"normal output".as_slice(),
        b"\x1b]11;rgb:0000/0000/0000\x07",
        b"\x1b]12;?\x07",
    ] {
        assert!(output.append(data).unwrap().is_empty());
    }
}

#[test]
fn neovim_background_query_receives_the_ordered_status_barrier_for_every_split() {
    let query = b"\x1b]11;?\x07\x1b[5n";
    for split in 0..=query.len() {
        let mut output = ProbeOutput::default();
        let mut replies = output.append(&query[..split]).unwrap();
        replies.extend(output.append(&query[split..]).unwrap());
        assert_eq!(
            replies, b"\x1b]11;rgb:0000/0000/0000\x07\x1b[0n",
            "split {split}"
        );
    }
}
pub(super) const EDITOR_READY: &[u8] = b"TENGRI_EDITOR_READY";

pub(super) fn editor_probe_command() -> Vec<u8> {
    let characters = EDITOR_READY
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "nvim /tmp/tengri-kvm-editor.txt +\"lua vim.schedule(function() vim.api.nvim_buf_set_lines(0,0,-1,false,{{string.char({characters})}}); vim.cmd('redraw') end)\"; printf '\\036TENGRI_EDITOR_EXIT\\037'\n"
    )
    .into_bytes()
}
