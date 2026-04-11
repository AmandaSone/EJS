//-----------------------------------------------------------------------------//
// Samlet håndtering for like, kommentarer, vis/skjul, paginering og auto-grow //
//---------------------------------------------------------------------------- //

  document.addEventListener('click', async (e) => { // Lytter på alle klikk
    const logoutBtn = e.target.closest('#logoutBtn'); // Sjekker om det ble klikket på element med id=logoutBtn
    if (logoutBtn) { // Hvis logout-knappen ble klikket
      e.preventDefault(); // Hindrer eventuell standard-navigasjon (viktig hvis det blir <a> senere)
      try { // Prøver å kalle logout-API
        const res = await fetch('/api/auth/logout', { // Kaller POST /api/auth/logout
          method: 'POST', // Bruker POST for å slette sesjonen
          headers: { 'Content-Type': 'application/json' } // Setter JSON-header (ufarlig her)
        }); // Slutt fetch
        const data = await res.json(); // Leser JSON-responsen
        if (!res.ok || !data.ok) { // Sjekker for API-feil
          alert(data.error || 'Kunne ikke logge ut'); // Viser enkel feilmelding
          return; // Stopper videre kjøring ved feil
        } // Slutt feil-sjekk
        window.location.href = '/'; // Ved suksess: naviger til forsiden
      } catch (err) { // Fanger uventede/nettverksfeil
        console.error(err); // Logger feilen
        alert('En uventet feil oppstod ved utlogging'); // Viser feilmelding
      } // Slutt try/catch
      return; // Viktig: avslutt denne klikk-håndteringen her
    };  // Slutt Logout 

    const likeBtn = e.target.closest('.like-btn'); // Sjekker om like-knapp ble klikket
    if (likeBtn) { // Håndter like/unlike
      const postId = likeBtn.dataset.postId; // Leser PostID
      try { // Kaller API for toggle like
        const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/like`, { method: 'POST' }); // Toggle like
        if (res.status === 401) { alert('You must log in to like.'); return; } // Ikke innlogget
        const data = await res.json(); // Leser JSON
        if (!res.ok || !data.ok) { alert(data.error || 'Could not update like'); return; } // API-feil
        likeBtn.setAttribute('aria-pressed', data.liked ? 'true' : 'false'); // Oppdater ARIA
        const labelEl = likeBtn.querySelector('.like-label'); if (labelEl) labelEl.textContent = data.liked ? 'Unlike' : 'Like'; // Label
        const countEl = likeBtn.querySelector('.like-count'); if (countEl) countEl.textContent = data.likes; // Teller
      } catch (err) { console.error('Like error:', err); alert('Unexpected error'); } // Feilhåndtering
      return; // Avslutt denne grenen
    } // Slutt like

    const sendBtn = e.target.closest('.comment-send'); // Sjekker om “Send”-knappen ble klikket
    if (sendBtn) { // Håndter ny kommentar
      const parentId = sendBtn.dataset.parentId; // Leser parent PostID
      const input = document.querySelector(`.comment-input[data-parent-id="${CSS.escape(parentId)}"]`); // Finner textarea
      if (!input) { alert('Could not find comment input'); return; } // Sikkerhet
      const text = input.value.trim(); if (!text) { alert('Comment cannot be empty'); return; } // Validering

      try { // Kaller API for å opprette kommentar
        const res = await fetch(`/api/posts/${encodeURIComponent(parentId)}/comments`, { // Endepunkt
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) // JSON-body
        }); // Slutt fetch
        if (res.status === 401) { alert('You must log in to comment.'); return; } // Ikke innlogget
        const data = await res.json(); if (!res.ok || !data.ok) { alert(data.error || 'Could not add comment'); return; } // API-feil

        const countEl = document.querySelector(`.comment-count[data-parent-id="${CSS.escape(parentId)}"]`); // Teller ved like-knapp
        if (countEl) countEl.textContent = data.commentCount; // Oppdater teller

        const actionsRow = sendBtn.closest('.post-box').querySelector('.actions-row'); // Finn rad med “View/Hide”
        let toggleBtn = actionsRow.querySelector(`.comments-toggle[data-parent-id="${CSS.escape(parentId)}"]`); // Finn toggle
        if (!toggleBtn) { // Hvis første kommentar (tidl. 0)
          toggleBtn = document.createElement('button'); // Lag knapp
          toggleBtn.type = 'button'; toggleBtn.className = 'comments-toggle'; toggleBtn.setAttribute('data-parent-id', parentId); // Attributter
          actionsRow.appendChild(toggleBtn); // Legg til i rad
        }
        toggleBtn.textContent = 'Hide comments'; // Vis at lista nå er åpen

        const listEl = document.querySelector(`.comment-list[data-parent-id="${CSS.escape(parentId)}"]`); // Finn lista
        if (listEl) { // Hvis lista finnes
          listEl.classList.remove('hidden'); // Vis lista
          const wrapper = document.createElement('div'); // Ny kommentar-wrapper
          wrapper.className = 'comment'; // Klasse for stil
          // Sett inn ny kommentar ØVERST i lista (før første .comment eller før pager)
          const header = document.createElement('p'); header.className = 'comment-header'; // Header
          header.innerHTML = `<strong>${escapeHtml(data.comment.username)}</strong> • ${new Date(data.comment.created_at).toLocaleString('nb-NO')}`; // Forfatter + tid
          const body = document.createElement('p'); body.className = 'post-content'; body.textContent = data.comment.content; // Tekst
          wrapper.appendChild(header); wrapper.appendChild(body); // Sett sammen
          const firstComment = listEl.querySelector('.comment'); // Første kommentar i lista
          const pager = listEl.querySelector('.comments-pagination'); // Paginering-kontroller
          if (firstComment) { // Hvis det finnes en kommentar
            listEl.insertBefore(wrapper, firstComment); // Sett ny øverst
          } else if (pager) { // Hvis ingen kommentarer, men pager finnes
            listEl.insertBefore(wrapper, pager); // Sett før pager
          } else { // Ingen kommentarer og ingen pager
            listEl.appendChild(wrapper); // Bare legg til
          }

          renumberAndPaginate(listEl, 5); // Renummerer data-idx fra 0..n og oppdaterer synlig-antall (baseline 5)
          ensurePagerAtBottom(listEl); // Sørger for at pager ligger nederst
          ensurePagerVisibility(listEl, parentId); // Oppretter/oppdaterer “Show more/less”-knapper
        }

        input.value = ''; input.style.height = 'auto'; // Tøm felt og reset høyde
      } catch (err) { console.error('Comment error:', err); alert('Unexpected error'); } // Feil
      return; // Avslutt denne grenen
    } // Slutt ny kommentar

    const toggleBtn = e.target.closest('.comments-toggle'); // Sjekk “View/Hide comments” (ikke more/less)
    if (toggleBtn && !toggleBtn.classList.contains('comments-more') && !toggleBtn.classList.contains('comments-less')) {
      const parentId = toggleBtn.dataset.parentId; // Parent id
      const listEl = document.querySelector(`.comment-list[data-parent-id="${CSS.escape(parentId)}"]`); // Liste
      const countEl = document.querySelector(`.comment-count[data-parent-id="${CSS.escape(parentId)}"]`); // Teller
      const total = countEl ? Number(countEl.textContent) : 0; // Antall
      if (!listEl) return; // Sikkerhet

      if (listEl.classList.contains('hidden')) { // Var skjult → vis
        listEl.classList.remove('hidden'); // Vis
        if (!listEl.dataset.visibleCount) listEl.dataset.visibleCount = String(Math.min(5, total)); // Sett baseline hvis mangler
        renumberAndPaginate(listEl, 5); // Oppdater synligheten på første åpning
        ensurePagerAtBottom(listEl); // Pager nederst
        ensurePagerVisibility(listEl, parentId); // Oppdater pager-knapper
        toggleBtn.textContent = 'Hide comments'; // Sett label
      } else { // Var synlig → skjul
        listEl.classList.add('hidden'); // Skjul
        toggleBtn.textContent = total > 0 ? `View ${total} comments` : 'View comments'; // Label med antall
      }
      return; // Avslutt
    } // Slutt View/Hide

    const moreBtn = e.target.closest('.comments-more'); // “Show more”
    if (moreBtn) { // Håndter “Show more”
      const parentId = moreBtn.dataset.parentId; // Parent id
      const listEl = document.querySelector(`.comment-list[data-parent-id="${CSS.escape(parentId)}"]`); // Liste
      if (!listEl) return; // Sikkerhet
      let visible = Number(listEl.dataset.visibleCount) || 5; // Nåværende synlig
      const total = listEl.querySelectorAll('.comment').length; // Totalt
      visible = Math.min(visible + 10, total); // +10, maks total
      listEl.dataset.visibleCount = String(visible); // Lagre
      applyVisibility(listEl, visible); // Skjul/vis elementer basert på index
      ensurePagerAtBottom(listEl); // Pager nederst
      updatePagerButtons(listEl); // Oppdater more/less synlighet
      return; // Avslutt
    } // Slutt more

    const lessBtn = e.target.closest('.comments-less'); // “Show less”
    if (lessBtn) { // Håndter “Show less”
      const parentId = lessBtn.dataset.parentId; // Parent id
      const listEl = document.querySelector(`.comment-list[data-parent-id="${CSS.escape(parentId)}"]`); // Liste
      if (!listEl) return; // Sikkerhet
      let visible = Number(listEl.dataset.visibleCount) || 5; // Nåværende synlig
      visible = Math.max(5, visible - 10); // -10, minst 5
      listEl.dataset.visibleCount = String(visible); // Lagre
      applyVisibility(listEl, visible); // Skjul/vis elementer
      ensurePagerAtBottom(listEl); // Pager nederst
      updatePagerButtons(listEl); // Oppdater knapper
      return; // Avslutt
    } // Slutt less
  }); // Slutt click-lytter

  document.addEventListener('input', (e) => { // Auto-grow for kommentar-tekstfelt
    const ta = e.target.closest('.comment-input'); if (!ta) return; // Kun for comment-input
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; // Justér høyde til innhold
  }); // Slutt input-lytter

  function renumberAndPaginate(listEl, baseline) { // Renummerer data-idx og anvender synlighet
    const comments = Array.from(listEl.querySelectorAll('.comment')); // Alle kommentarer
    comments.forEach((el, i) => { el.dataset.idx = String(i); }); // Sett data-idx i DOM-rekkefølge
    let visible = Number(listEl.dataset.visibleCount) || baseline; // Hent lagret synlig-antall
    if (visible < baseline) visible = baseline; // Minst baseline
    if (visible > comments.length) visible = comments.length; // Ikke over total
    applyVisibility(listEl, visible); // Skjul/vis etter index
    listEl.dataset.visibleCount = String(visible); // Lagre
  } // Slutt renumberAndPaginate

  function applyVisibility(listEl, visible) { // Skjul/vis kommentarer etter index
    const comments = Array.from(listEl.querySelectorAll('.comment')); // Hent kommentarer
    comments.forEach((el, i) => { el.classList.toggle('hidden', i >= visible); }); // Skjul hvis index >= visible
  } // Slutt applyVisibility

  function ensurePagerAtBottom(listEl) { // Sørg for at pager ligger nederst
    const pager = listEl.querySelector('.comments-pagination'); // Finn pager
    if (pager) listEl.appendChild(pager); // Flytt til slutt
  } // Slutt ensurePagerAtBottom

  function ensurePagerVisibility(listEl, parentId) { // Opprett/oppdater pager ved behov
    const total = listEl.querySelectorAll('.comment').length; // Totalt antall
    let pager = listEl.querySelector('.comments-pagination'); // Finn pager
    if (!pager && total > 5) { // Opprett hvis mangler og >5
      pager = document.createElement('div'); pager.className = 'comments-pagination'; pager.setAttribute('data-parent-id', parentId); // Container
      const more = document.createElement('button'); more.type = 'button'; more.className = 'comments-toggle comments-more'; more.setAttribute('data-parent-id', parentId); more.textContent = 'Show more'; // More
      const less = document.createElement('button'); less.type = 'button'; less.className = 'comments-toggle comments-less hidden'; less.setAttribute('data-parent-id', parentId); less.textContent = 'Show less'; // Less
      pager.appendChild(more); pager.appendChild(less); listEl.appendChild(pager); // Legg til
    }
    updatePagerButtons(listEl); // Oppdater synlighet på more/less
  } // Slutt ensurePagerVisibility

  function updatePagerButtons(listEl) { // Skjul/vis “more/less” ut fra visible/total
    const total = listEl.querySelectorAll('.comment').length; // Totalt
    const visible = Number(listEl.dataset.visibleCount) || 5; // Synlig
    const moreBtn = listEl.querySelector('.comments-more'); // More
    const lessBtn = listEl.querySelector('.comments-less'); // Less
    if (moreBtn) moreBtn.classList.toggle('hidden', visible >= total); // Skjul more hvis alt synlig
    if (lessBtn) lessBtn.classList.toggle('hidden', visible <= 5); // Skjul less hvis baseline
  } // Slutt updatePagerButtons

  function escapeHtml(s) { // Enkel HTML-escape
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  } // Slutt escapeHtml