Rails.application.routes.draw do
  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  resources :edit_sessions, only: [:new, :create, :show, :index, :destroy] do
    member do
      get :export
    end

    scope module: "edit_sessions" do
      post :fuzzy_select, to: "selections#fuzzy_select"
      post :gradient_select, to: "selections#gradient_select"
      post :select_by_color, to: "selections#select_by_color"
      post :gradient_select_from_selection, to: "selections#gradient_select_from_selection"
      post :select_all, to: "selections#select_all"
      post :deselect_all, to: "selections#deselect_all"
      post :free_select, to: "selections#free_select"
      post :line_select, to: "selections#line_select"
      post :brush_select, to: "selections#brush_select"
      post :rect_select, to: "selections#rect_select"
      post :split_selection, to: "selections#split_selection"
      post :smooth_auto_fill, to: "selections#smooth_auto_fill"
      post :invert, to: "selections#invert"
      post :remove_holes, to: "selections#remove_holes"
      post :grow_selection, to: "selections#grow_selection"
      post :select_border, to: "selections#select_border"
      post :delete, to: "selections#delete"
      post :undo, to: "selections#undo"
      post :redo, to: "selections#redo"
      post :save_selection, to: "selections#save_selection"
      get :saved_selections, to: "selections#saved_selections"
      post :merge_selection, to: "selections#merge_selection"
    end
  end

  root "edit_sessions#new"
end
